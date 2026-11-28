# CI (Windows): click through the real installer like a person would, then update over it silently like the app does.
#   python scripts/windows-installer-check.py dist/Yogurt-windows-x64.exe <screenshots folder>
# 1. custom install folder and models folder, chosen on the pages; 2. a silent update over it (no pages, nothing moved);
# 3. the installed app (fake mode, nothing downloaded) looks for its models in the chosen folder;
# 4. a fresh install with the defaults; 5. models already there: the models page is skipped.
import os, re, shutil, subprocess, sys, threading, time, winreg
from pathlib import Path

from PIL import ImageGrab
from pywinauto import Desktop

INSTALLER = Path(sys.argv[1]).resolve()
SHOTS = Path(sys.argv[2]).resolve()
SHOTS.mkdir(parents=True, exist_ok=True)
APP_DIR = Path(r'C:\YogurtTest\app')
MODELS = Path(r'C:\YogurtModels')
PROFILE = Path(os.environ['APPDATA']) / 'Yogurt'
DEFAULT_APP_DIR = Path(os.environ['LOCALAPPDATA']) / 'Programs' / 'Yogurt'
UNINSTALL = r'Software\Microsoft\Windows\CurrentVersion\Uninstall'

results: list[tuple[str, bool]] = []
shot_n = 0


def check(name: str, ok: bool, detail: object = '') -> None:
    results.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)


def screenshot(name: str, win=None) -> None:
    global shot_n
    shot_n += 1
    path = SHOTS / f'{shot_n:02d}-{name}.png'
    try:
        if win is not None:
            try: win.set_focus()
            except Exception: pass
            time.sleep(0.4)
            win.capture_as_image().save(path)
        else:
            ImageGrab.grab().save(path)
    except Exception as e:
        print('screenshot failed, whole screen instead:', e)
        ImageGrab.grab().save(path)


def setup_windows() -> list:
    return [w for w in Desktop(backend='win32').windows(class_name='#32770', visible_only=True) if 'Yogurt' in w.window_text()]


def page_text(win) -> str:
    return ' | '.join(c.window_text() for c in win.descendants() if c.is_visible() and c.window_text())


def wait(what: str, fn, timeout: float = 180):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
            if v: return v
        except Exception:
            pass
        time.sleep(0.5)
    screenshot(f'timeout-{re.sub(r"[^a-z]+", "-", what.lower())}')
    raise TimeoutError(what)


def wait_page(win, needle: str, timeout: float = 180) -> str:
    return wait(f'page with {needle}', lambda: (t := page_text(win)) and needle in t and t, timeout)


def click_next(win) -> None:
    # the window's own Next / Install / Finish button (id 1), not one on the page inside it
    next(c for c in win.children() if c.class_name() == 'Button' and c.control_id() == 1).click()


def visible_edit(win):
    return next(c for c in win.descendants(class_name='Edit') if c.is_visible())


def read_models_txt() -> str | None:
    f = PROFILE / 'models-dir.txt'
    if not f.exists(): return None
    raw = f.read_bytes()
    return (raw[2:].decode('utf-16-le') if raw[:2] == b'\xff\xfe' else raw.decode('utf-8')).strip()


def uninstall_entries(root) -> list[dict]:
    out = []
    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try: key = winreg.OpenKey(root, UNINSTALL, 0, winreg.KEY_READ | view)
        except OSError: continue
        for i in range(winreg.QueryInfoKey(key)[0]):
            try:
                sub = winreg.OpenKey(key, winreg.EnumKey(key, i))
                name = winreg.QueryValueEx(sub, 'DisplayName')[0]
            except OSError:
                continue
            if str(name).startswith('Yogurt'):
                # electron-builder leaves InstallLocation out: the uninstaller's path says where it is
                try: un = winreg.QueryValueEx(sub, 'UninstallString')[0]
                except OSError: un = ''
                m = re.match(r'"([^"]+)"', un)
                entry = {'name': name, 'location': str(Path(m.group(1)).parent) if m else ''}
                if entry not in out: out.append(entry)
    return out


class ConsentWatch:
    """Notes any UAC prompt (consent.exe) while the installer runs."""
    def __init__(self) -> None:
        self.seen = False
        self.stop = False
        threading.Thread(target=self.run, daemon=True).start()

    def run(self) -> None:
        while not self.stop:
            out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq consent.exe', '/NH'], capture_output=True, text=True).stdout
            if 'consent.exe' in out.lower(): self.seen = True
            time.sleep(0.5)


def run_app_and_read_models_dir() -> str | None:
    """The installed app in fake mode (nothing downloaded): its log says where it looks for the models."""
    log = PROFILE / 'logs' / 'main.log'
    before = log.read_text(encoding='utf-8', errors='replace') if log.exists() else ''
    exe = next(p for p in (APP_DIR / 'Yogurt.exe', DEFAULT_APP_DIR / 'Yogurt.exe') if p.exists())
    env = {**os.environ, 'YOGURT_FAKE': '1'}
    proc = subprocess.Popen([str(exe)], env=env)
    try:
        def found():
            text = log.read_text(encoding='utf-8', errors='replace') if log.exists() else ''
            m = re.findall(r'MODELS dir=(.+)', text[len(before):])
            return m[-1].strip() if m else None
        return wait('the app logs its models folder', found, 90)
    finally:
        time.sleep(3)
        screenshot('app-running')
        subprocess.run(['taskkill', '/IM', 'Yogurt.exe', '/F', '/T'], capture_output=True)
        proc.wait(30)
        time.sleep(2)


def click_through(label: str, app_dir: Path | None, models_dir: Path | None, expect_models_page: bool = True) -> None:
    """Runs the installer with its pages; None keeps a page's default."""
    consent = ConsentWatch()
    proc = subprocess.Popen([str(INSTALLER)])
    win = wait('the installer window', lambda: (ws := setup_windows()) and ws[0], 120)
    first = wait_page(win, 'Choose Install Location', 60)
    check(f'{label}: the first page is the install folder (no "for all users" question, which needs an admin)',
          'Anyone who uses this computer' not in first and 'Only for me' not in first, first[:200])
    screenshot(f'{label}-install-folder', win)
    if app_dir:
        visible_edit(win).set_edit_text(str(app_dir))
        time.sleep(0.5)
        screenshot(f'{label}-install-folder-changed', win)
    click_next(win)
    time.sleep(1.5)
    text = page_text(win)
    if expect_models_page:
        # a busy CI runner can take well over 30 s to show the next installer page
        text = wait_page(win, 'AI models')
        check(f'{label}: the models page has its own heading', 'Choose where the AI models go' in text and 'Choose Install Location' not in text, text[:200])
        field = visible_edit(win)
        default = field.window_text()
        check(f'{label}: the models page offers the profile folder by default', default.lower() == str(PROFILE / 'models').lower(), default)
        screenshot(f'{label}-models-folder', win)
        if models_dir:
            field.set_edit_text(str(models_dir))
            time.sleep(0.5)
            screenshot(f'{label}-models-folder-changed', win)
        click_next(win)
    else:
        check(f'{label}: no models page when models are already downloaded', 'AI models' not in text, text[:200])
    # installing, then the last page: Yogurt is not started from it here (the checks start it themselves)
    wait('the installer to finish', lambda: 'Finish' in page_text(win) or 'Completing' in page_text(win), 600)
    screenshot(f'{label}-finish', win)
    for c in win.descendants(class_name='Button'):
        if c.is_visible() and 'Run' in c.window_text():
            try: c.uncheck()
            except Exception: pass
    click_next(win)
    proc.wait(60)
    consent.stop = True
    check(f'{label}: the installer exits cleanly', proc.returncode == 0, proc.returncode)
    check(f'{label}: no admin (UAC) prompt came up', not consent.seen)


def uninstall(app_dir: Path) -> None:
    un = next(app_dir.glob('Uninstall*.exe'))
    subprocess.run([str(un), '/S', f'_?={app_dir}'], timeout=300)
    shutil.rmtree(app_dir, ignore_errors=True)


def main() -> int:
    data = INSTALLER.read_bytes()
    level = re.search(rb'requestedExecutionLevel\s+level="(\w+)"', data)
    check('the installer never asks Windows for an admin (manifest asInvoker)', level and level.group(1) == b'asInvoker', level and level.group(1))

    shutil.rmtree(PROFILE, ignore_errors=True)
    shutil.rmtree(MODELS, ignore_errors=True)

    # 1. custom folders, clicked through
    click_through('custom', APP_DIR, MODELS)
    check('custom: the app is in the chosen install folder', (APP_DIR / 'Yogurt.exe').exists(), APP_DIR)
    check('custom: nothing in the default install folder', not (DEFAULT_APP_DIR / 'Yogurt.exe').exists())
    check('custom: models-dir.txt holds the chosen models folder', read_models_txt() == str(MODELS), read_models_txt())
    check('custom: the models folder was made', MODELS.is_dir())
    hkcu, hklm = uninstall_entries(winreg.HKEY_CURRENT_USER), uninstall_entries(winreg.HKEY_LOCAL_MACHINE)
    check('custom: the uninstall entry is under HKCU, pointing at the chosen folder',
          any(Path(e['location']) == APP_DIR for e in hkcu), hkcu)
    check('custom: no uninstall entry under HKLM (not installed for all users)', not hklm, hklm)

    # 2. a silent update over it, the way the app installs one (--updated /S)
    saved = (PROFILE / 'models-dir.txt').read_bytes()
    (APP_DIR / 'Yogurt.exe').unlink()
    seen: list[str] = []
    proc = subprocess.Popen([str(INSTALLER), '--updated', '/S'])
    while proc.poll() is None:
        seen += [w.window_text() for w in setup_windows()]
        time.sleep(0.2)
    check('update: exits cleanly', proc.returncode == 0, proc.returncode)
    check('update: shows no pages', not seen, sorted(set(seen)))
    check('update: models-dir.txt is unchanged', (PROFILE / 'models-dir.txt').read_bytes() == saved)
    check('update: the app lands in the chosen install folder again', wait('Yogurt.exe back', lambda: (APP_DIR / 'Yogurt.exe').exists(), 60))
    check('update: still nothing in the default install folder', not (DEFAULT_APP_DIR / 'Yogurt.exe').exists())

    # 3. the installed app looks for its models in the chosen folder
    found = run_app_and_read_models_dir()
    check('app: looks for its models in the chosen folder', found and Path(found) == MODELS, found)

    # 4. a fresh install with the defaults
    uninstall(APP_DIR)
    shutil.rmtree(PROFILE, ignore_errors=True)
    click_through('defaults', None, None)
    check('defaults: the app is in the default install folder', (DEFAULT_APP_DIR / 'Yogurt.exe').exists(), DEFAULT_APP_DIR)
    check('defaults: no models-dir.txt (the profile folder is used)', read_models_txt() is None, read_models_txt())
    found = run_app_and_read_models_dir()
    check('defaults app: looks for its models in the profile', found and Path(found) == PROFILE / 'models', found)

    # 5. models already downloaded: the page is skipped, nothing is written
    uninstall(DEFAULT_APP_DIR)
    (PROFILE / 'models' / 'llm').mkdir(parents=True, exist_ok=True)
    (PROFILE / 'models' / 'llm' / 'model.gguf').write_text('fake')
    click_through('models-exist', None, None, expect_models_page=False)
    check('models-exist: no models-dir.txt written', read_models_txt() is None, read_models_txt())

    failed = [n for n, ok in results if not ok]
    print(f'\n{len(results) - len(failed)} of {len(results)} checks passed')
    for n in failed: print('FAILED:', n)
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        screenshot('error')
        raise
