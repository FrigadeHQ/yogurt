#!/usr/bin/env node
// Builds nemo-speech (speaker diarization) for Windows (x64) and Linux (x86_64) into resources/bin, like whisper-build.mjs
// builds whisper-server. The Mac build stays in native.sh. One binary next to its backend libraries, so at start it picks
// Vulkan when a graphics driver has it and the CPU otherwise. Needs git, cmake 3.26 or newer and a C++ compiler — the same
// ones whisper-server needs — plus the Vulkan SDK (VULKAN_SDK set), and SentencePiece, which this builds from the pin
// NeMo-Speech.cpp itself pins (its scripts/build_sentencepiece_static.sh needs Ninja; we build the same commit without it).
// --cpu-only builds without Vulkan, for a quick local build without the SDK.
//
// Flags were read off the pinned checkout (Task 10, steps 1-2): option() names in its CMakeLists.txt, the vulkan-asr
// preset in its CMakePresets.json, and its release workflow (.github/workflows/release.yml: -DGGML_NATIVE=OFF). The CLI
// target is nemo_speech_cli (OUTPUT_NAME nemo-speech); ggml comes from the checkout's llama.cpp submodule. Unlike
// whisper.cpp, there is no GGML_BACKEND_DL here: NeMo's ASR/diarization runtime never calls ggml_backend_load_all(), so a
// dynamically loaded Vulkan backend would never register and would be skipped silently — the linked shared backend is
// what its presets build. The Windows build is written but not verified on a machine with Visual Studio yet (Task 12
// brings the runtime up): its SentencePiece comes from the vcpkg manifest the pin ships, with the triplet matching the
// static C++ runtime below.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NEMO_COMMIT = 'c540e21167017d2e34444f2fc2d70649065dc500'
// SentencePiece, the ASR engine's tokenizer, at the commit pinned by NeMo-Speech.cpp's scripts/build_sentencepiece_static.sh
const SENTENCEPIECE_COMMIT = '31646a467d2051eb904e0b45de3a73e91fe1c1e3'

const win = process.platform === 'win32'
if (process.platform !== 'win32' && process.platform !== 'linux') process.exit(0)
const cpuOnly = process.argv.includes('--cpu-only')
const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = fileURLToPath(import.meta.url)
const dir = join(app, 'native', '.nemo-build')
const bin = join(app, 'resources', 'bin')
const out = join(bin, win ? 'nemo-speech.exe' : 'nemo-speech')
// the CLI's rpath is $ORIGIN/../lib (its CMakeLists at the pin): on Linux the libraries get their own folder next to
// resources/bin — which also keeps them out of whisper-server's reach — while Windows needs them next to the exe
const libDir = win ? bin : join(app, 'resources', 'lib')

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) { console.error(`${cmd} ${args.join(' ')} failed${r.error ? `: ${r.error.message}` : ''}`); process.exit(1) }
  return r
}
const newer = (a, b) => statSync(a).mtimeMs > statSync(b).mtimeMs
const newest = (d) => {
  let t = 0
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'build' || e.name === '.deps' || e.name.startsWith('.git')) continue
    const p = join(d, e.name)
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs)
  }
  return t
}

if (existsSync(out) && !newer(script, out) && statSync(out).mtimeMs > newest(dir)) { console.log('nemo-speech is up to date'); process.exit(0) }
if (!cpuOnly && !process.env.VULKAN_SDK && win) { console.error('the Vulkan SDK is needed (set VULKAN_SDK), or pass --cpu-only'); process.exit(1) }

if (!existsSync(join(dir, '.git'))) run('git', ['clone', '--quiet', 'https://github.com/NVIDIA/NeMo-Speech.cpp', dir])
run('git', ['-C', dir, 'checkout', '--quiet', '--force', NEMO_COMMIT])
const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
if (head !== NEMO_COMMIT) { console.error(`NeMo-Speech.cpp is not at ${NEMO_COMMIT}`); process.exit(1) }
// ggml lives in the llama.cpp submodule; its CMake adds it (cmake/llama_cpp.cmake)
run('git', ['-C', dir, 'submodule', 'update', '--init', '--depth', '1', 'llama.cpp'])

// SentencePiece statically, into the checkout's .deps, which its CMake searches by default (NEMO_SPEECH_DEPENDENCY_PREFIX).
// The same commit and cmake flags as its own scripts/build_sentencepiece_static.sh, minus -G Ninja: cmake plus a compiler
// is enough. Only needed off Windows, where the vcpkg manifest provides it instead.
if (!win) {
  const prefix = join(dir, '.deps', 'sentencepiece')
  if (!existsSync(join(prefix, 'lib', 'libsentencepiece.a'))) {
    const src = join(dir, '.deps', 'sentencepiece-src')
    const build = join(dir, '.deps', 'sentencepiece-build')
    if (!existsSync(join(src, '.git'))) run('git', ['clone', '--quiet', 'https://github.com/google/sentencepiece.git', src])
    run('git', ['-C', src, 'fetch', '--quiet', '--depth', '1', 'origin', SENTENCEPIECE_COMMIT])
    run('git', ['-C', src, 'checkout', '--quiet', '--force', SENTENCEPIECE_COMMIT])
    rmSync(build, { recursive: true, force: true })
    run('cmake', ['-S', src, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DSPM_BUILD_TEST=OFF', '-DSPM_ENABLE_SHARED=OFF', '-DSPM_ENABLE_TCMALLOC=OFF'], { env: { ...process.env, CMAKE_POLICY_VERSION_MINIMUM: '3.5' } })
    run('cmake', ['--build', build, '--config', 'Release', '--target', 'sentencepiece-static', '-j', String(cpus().length)])
    mkdirSync(join(prefix, 'lib'), { recursive: true })
    mkdirSync(join(prefix, 'include'), { recursive: true })
    copyFileSync(join(build, 'src', 'libsentencepiece.a'), join(prefix, 'lib', 'libsentencepiece.a'))
    copyFileSync(join(src, 'src', 'sentencepiece_processor.h'), join(prefix, 'include', 'sentencepiece_processor.h'))
    console.log('built SentencePiece statically into the checkout')
  }
}

const build = join(dir, 'build')
rmSync(build, { recursive: true, force: true })
const flags = [
  '-DCMAKE_BUILD_TYPE=Release',
  // ggml defaults to shared libraries here (its CMakeLists), and the nemo libraries follow BUILD_SHARED_LIBS:
  // separate files next to the binary, like whisper-server's
  '-DBUILD_SHARED_LIBS=ON',
  // the vulkan-asr preset's component set: diarization shares the ASR runtime and needs nothing else
  '-DNEMO_SPEECH_BUILD_TESTS=OFF', '-DNEMO_SPEECH_BUILD_EXAMPLES=OFF', '-DNEMO_SPEECH_BUILD_TOOLS=OFF',
  '-DNEMO_SPEECH_BUILD_TTS=OFF', '-DNEMO_SPEECH_BUILD_NMT=OFF', '-DNEMO_SPEECH_BUILD_HTTP=OFF',
  // stock ggml, the way its vulkan and metal presets build (its release builds pass -DGGML_NATIVE=OFF too); OpenMP off
  // so no libgomp.so.1 / vcomp140.dll is needed on the computers this runs on, as whisper-build.mjs does
  '-DNEMO_SPEECH_GGML_PATCHED=OFF', '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF',
  `-DGGML_VULKAN=${cpuOnly ? 'OFF' : 'ON'}`,
]
if (win) {
  // the C++ runtime inside each file: a computer without the Visual C++ Redistributable runs it too. The vcpkg triplet
  // below must match that runtime (x64-windows-static), as NeMo-Speech.cpp's scripts/windows/build.ps1 does for its own.
  flags.push('-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded')
  const vcpkg = process.env.VCPKG_ROOT ?? process.env.VCPKG_INSTALLATION_ROOT
  if (!vcpkg) { console.error('nemo-speech needs SentencePiece: set VCPKG_ROOT (the vcpkg checkout; the pin ships the manifest), or pass YOGURT_NO_NEMO=1'); process.exit(1) }
  flags.push(`-DCMAKE_TOOLCHAIN_FILE=${join(vcpkg, 'scripts', 'buildsystems', 'vcpkg.cmake')}`, '-DVCPKG_TARGET_TRIPLET=x64-windows-static', '-DVCPKG_MANIFEST_FEATURES=asr')
} else {
  // the libraries sit next to nemo-speech and are found there
  flags.push('-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON')
}
// libopus (built by the Rust helpers) is not the only checkout that wants an old CMake policy
run('cmake', ['-S', dir, '-B', build, ...flags], { env: { ...process.env, CMAKE_POLICY_VERSION_MINIMUM: '3.5' } })
// ggml's backends (ggml, ggml-base, ggml-cpu and, with Vulkan, ggml-vulkan) come along as dependencies
run('cmake', ['--build', build, '--config', 'Release', '--target', 'nemo_speech_cli', '-j', String(cpus().length)])

const built = win ? join(build, 'bin', 'Release') : join(build, 'bin')
mkdirSync(bin, { recursive: true })
mkdirSync(libDir, { recursive: true })
// Linux names its libraries for the linker (libggml.so -> libggml.so.0 -> libggml.so.0.25.1) but resolves them by their
// soname (libggml.so.0): copy the real files and recreate the chain of links they sit behind
const isLib = (name) => (win ? name.endsWith('.dll') : /^lib.*\.so(\.|$)/.test(name))
const libs = readdirSync(built, { withFileTypes: true }).filter((e) => isLib(e.name))
for (const e of libs) {
  const src = join(built, e.name)
  const dest = join(libDir, e.name)
  if (!win && e.isSymbolicLink()) {
    rmSync(dest, { force: true })
    symlinkSync(readlinkSync(src), dest)
  } else copyFileSync(src, dest)
}
copyFileSync(join(built, win ? 'nemo-speech.exe' : 'nemo-speech'), out)
if (!win) spawnSync('chmod', ['0755', out])
// a Windows build may need the UTF-8 manifest whisper-server gets (whisper-build.mjs), once model paths reach it
console.log(`built ${out} with ${libs.map((e) => e.name).join(', ')}${win ? '' : ` in ${libDir}`}`)
