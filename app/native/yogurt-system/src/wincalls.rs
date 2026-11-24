//! `yogurt-system call-watch MS ID...` on Windows: who is in a call and who is talking, as the call app shows it through
//! UI Automation, one JSON line per reading (the same shape as yogurt-mac's call-watch and Linux's calls.rs).
//! UI Automation needs no permission. Chromium (Meet in Chrome or Edge, and the new Teams, which is Edge's WebView2)
//! gives its page's elements with their DOM classes as ClassName; Zoom gives its own controls.

use std::io::Read;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{
    AutomationElementMode_None, CUIAutomation, CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationCacheRequest,
    IUIAutomationElement, TreeScope_Subtree, UIA_AutomationIdPropertyId, UIA_ClassNamePropertyId, UIA_ControlTypePropertyId,
    UIA_HelpTextPropertyId, UIA_NamePropertyId,
};

use crate::call::{call_window, is_call_tree, kind, look, now_ms, to_read, Kind, Look};
use crate::parse;

/// at most this many call windows of the app per reading
const MAX_WINDOWS: usize = 4;
/// how much of one window is copied out, and how deep (as on Linux)
const BUDGET: i32 = 4000;
const MAX_DEPTH: usize = 40;
/// an app that stopped answering gives up its reading after this long, so it cannot hold the watch
const TIMEOUT_MS: u32 = 1500;
/// longer text is cut: names and labels are short
const MAX_TEXT: usize = 300;

struct Uia {
    uia: IUIAutomation,
    req: IUIAutomationCacheRequest,
}

impl Uia {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let uia: IUIAutomation = match CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) {
                Ok(u) => u,
                Err(_) => CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?,
            };
            if let Ok(u2) = uia.cast::<IUIAutomation2>() {
                let _ = u2.SetConnectionTimeout(TIMEOUT_MS);
                let _ = u2.SetTransactionTimeout(TIMEOUT_MS);
            }
            // the whole window comes over in one call, with just these properties: one element at a time would be a
            // round trip to the app each
            let req = uia.CreateCacheRequest()?;
            for p in [UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_HelpTextPropertyId, UIA_AutomationIdPropertyId, UIA_ClassNamePropertyId] {
                req.AddProperty(p)?;
            }
            req.SetTreeScope(TreeScope_Subtree)?;
            // the raw view keeps the page's plain containers, so Meet's tiles have the depth they have on Linux
            req.SetTreeFilter(&uia.RawViewCondition()?)?;
            req.SetAutomationElementMode(AutomationElementMode_None)?;
            Ok(Self { uia, req })
        }
    }

    fn tree(&self, hwnd: u64) -> Option<Value> {
        let el = unsafe { self.uia.ElementFromHandleBuildCache(HWND(hwnd as usize as *mut core::ffi::c_void), &self.req) }.ok()?;
        let mut budget = BUDGET;
        Some(node(&el, 0, &mut budget))
    }
}

fn clip(s: &str) -> String {
    let s = s.trim();
    match s.char_indices().nth(MAX_TEXT) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// One element and what is under it, in the shape src/main/callNames/parse.ts reads (AxNode). What someone types is
/// never copied: an edit field's value is not asked for.
fn node(el: &IUIAutomationElement, depth: usize, budget: &mut i32) -> Value {
    *budget -= 1;
    let mut n = Map::new();
    unsafe {
        let role = el.CachedControlType().map(|t| parse::uia_role(t.0)).unwrap_or("unknown");
        n.insert("r".into(), json!(role));
        let name = el.CachedName().map(|b| b.to_string()).unwrap_or_default();
        if !name.trim().is_empty() {
            n.insert("t".into(), json!(clip(&name)));
        }
        if let Ok(help) = el.CachedHelpText().map(|b| b.to_string()) {
            if !help.trim().is_empty() && help != name {
                n.insert("d".into(), json!(clip(&help)));
            }
        }
        if let Ok(id) = el.CachedAutomationId().map(|b| b.to_string()) {
            if !id.is_empty() {
                n.insert("i".into(), json!(clip(&id)));
            }
        }
        if let Ok(class) = el.CachedClassName().map(|b| b.to_string()) {
            let classes: Vec<&str> = class.split_whitespace().take(20).collect();
            if !classes.is_empty() {
                n.insert("c".into(), json!(classes));
            }
        }
        if depth < MAX_DEPTH && *budget > 0 {
            if let Ok(kids) = el.GetCachedChildren() {
                let mut out = Vec::new();
                for i in 0..kids.Length().unwrap_or(0) {
                    if *budget <= 0 {
                        break;
                    }
                    if let Ok(k) = kids.GetElement(i) {
                        out.push(node(&k, depth + 1, budget));
                    }
                }
                if !out.is_empty() {
                    n.insert("k".into(), json!(out));
                }
            }
        }
    }
    Value::Object(n)
}

/// The watch: read the apps asked about every `every_ms`, until Yogurt closes stdin (or dies, which closes it too)
pub fn watch(every_ms: u64, ids: &[String]) -> ! {
    std::thread::spawn(|| {
        let mut sink = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut sink);
        std::process::exit(0);
    });
    let every = every_ms.max(100);
    let ids: Vec<String> = ids.iter().map(|id| id.to_lowercase()).collect();
    let mut uia: Option<Uia> = None;
    let mut complained = false;
    let mut last: Option<u64> = None;
    loop {
        let started = Instant::now();
        if uia.is_none() {
            match Uia::new() {
                Ok(u) => uia = Some(u),
                Err(e) => {
                    if !complained {
                        eprintln!("call-watch: {e}");
                        complained = true;
                    }
                }
            }
        }
        let line = match &uia {
            Some(u) => read_once(u, &ids, &mut last),
            None => json!({ "t": now_ms(), "error": "no-accessibility" }),
        };
        crate::out(line);
        // a slow app (a big page) is read less often, so the reading never takes much of the computer
        let took = started.elapsed().as_millis() as u64;
        std::thread::sleep(Duration::from_millis(every.max(took * 2).saturating_sub(took)));
    }
}

/// The first app asked about with a call window, and its call windows, top first. `last` is the Teams window that was
/// the call: it is read alone while it still is one (call::to_read).
fn read_once(u: &Uia, ids: &[String], last: &mut Option<u64>) -> Value {
    let t = now_ms();
    let procs = crate::win::processes();
    let mut seen = false;
    let mut mine = Vec::new();
    for (hwnd, pid, title) in crate::win::top_windows() {
        let Some(p) = procs.get(&pid) else { continue };
        let exe = parse::exe_id(&p.exe);
        let Some(id) = ids.iter().find(|id| **id == exe) else { continue };
        seen = true;
        if call_window(kind(id), &title) {
            mine.push((hwnd, (id.clone(), title)));
        }
    }
    let (first, alone) = to_read(mine.clone(), *last);
    let mut checked = None;
    if alone {
        let (hwnd, (id, title)) = &first[0];
        let tree = u.tree(*hwnd);
        match look(tree.as_ref(), crate::win::out_of_sight(*hwnd)) {
            Look::Call => return json!({ "t": t, "app": id, "windows": [{ "title": title, "tree": tree }] }),
            // it did not answer in time: the other windows would be as slow, so this reading is skipped
            Look::Slow => return json!({ "t": t, "error": "slow-call-window" }),
            // minimised or on another desktop: kept, and Yogurt is told the call is not over (#83: auto end on Windows)
            Look::Hidden => return json!({ "t": t, "error": "no-call-window", "hidden": true }),
            Look::Gone => {
                *last = None;
                checked = Some(*hwnd);
            }
        }
    }
    let mut app: Option<String> = None;
    let mut windows = Vec::new();
    for (hwnd, (id, title)) in mine {
        if windows.len() == MAX_WINDOWS || app.as_ref().is_some_and(|a| *a != id) {
            continue;
        }
        if checked == Some(hwnd) {
            continue;
        }
        let k = kind(&id);
        let Some(tree) = u.tree(hwnd) else { continue };
        // Teams's calendar and chat windows look like the call's: only a window with call controls is sent, so their
        // text never reaches the JSON or the log. Teams has one call window: once found, it is the one read.
        if k == Kind::Teams {
            if !is_call_tree(&tree) {
                continue;
            }
            *last = Some(hwnd);
        }
        app = Some(id.clone());
        windows.push(json!({ "title": title, "tree": tree }));
        if k == Kind::Teams {
            break;
        }
    }
    match app {
        Some(app) => json!({ "t": t, "app": app, "windows": windows }),
        None => json!({ "t": t, "error": if seen { "no-call-window" } else { "not-running" } }),
    }
}
