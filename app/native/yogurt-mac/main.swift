// Yogurt's Mac helper: the calendars this Mac already has (iCloud, Google, Exchange… added in System Settings →
// Internet Accounts) through EventKit, and which apps are using the microphone (Core Audio, macOS 14+).
// Prints JSON; errors go to stderr with exit 1.
//   yogurt-mac calendar-status       → {"status":"granted"|"denied"|"notDetermined"}
//   yogurt-mac calendar-auth         → asks once (the system's own prompt), then the status
//   yogurt-mac events FROM TO        → meetings between two ISO dates (all-day and cancelled ones left out)
//   yogurt-mac mic-apps              → [{"bundleId","name","pid"}] of processes using audio input right now
//   yogurt-mac running-apps ID...    → the supplied bundle IDs currently present in NSRunningApplication
//   yogurt-mac browser-title ID      → {"title":string|null}: the front tab's name in Chrome, Arc, Edge, Brave or Safari (only if running)
//   yogurt-mac permissions           → {"mic":"authorized"|"denied"|"restricted"|"notDetermined","systemAudio":0|1|2,"calendar":…,
//                                       "accessibility":bool}
//   yogurt-mac media-auth            → asks once to control each running player (the system's own prompt), then {"players"}
//   yogurt-mac mic-auth              → asks for the microphone once (the system's own prompt), then {"status"}
//   yogurt-mac audio-auth            → asks to record the computer's sound once, then {"status":0|1|2}
//   yogurt-mac media-pause           → {"paused":[bundle ids]}: pauses Music and Spotify, only those running and playing
//   yogurt-mac media-resume ID...    → {"resumed":[bundle ids]}: plays those again, unless they are already playing
//   yogurt-mac mic-devices           → {"devices":[{"uid","name","default":bool}]}: every microphone, and which one the Mac uses now
//   yogurt-mac ax-auth               → asks for Accessibility once (the system's own prompt), then {"trusted":bool}
//   yogurt-mac call-watch MS [--pid N]... ID...
//                                    → one JSON line every MS ms until stdin closes: the call app's meeting windows as
//                                       accessibility trees {"t","app","windows":[{"title","id","tree"}]}, or {"t","error"};
//                                       with --pid, only the app processes those mic processes belong to
import AVFoundation
import AppKit
import CoreAudio
import EventKit
import Foundation

let store = EKEventStore()
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
let dayIso = ISO8601DateFormatter()
dayIso.formatOptions = [.withFullDate]

func out(_ v: Any) { FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: v, options: [.sortedKeys])); print() }
func fail(_ msg: String) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(1) }
func date(_ s: String) -> Date {
  if let d = iso.date(from: s) { return d }
  let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: s) { return d }
  if let d = dayIso.date(from: s) { return d }
  fail("Couldn't read the date \"\(s)\". Use a form like 2026-10-21T15:00:00Z.")
}

func status() -> String {
  let s = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) { if s == .fullAccess { return "granted" } }
  switch s {
  case .authorized: return "granted"
  case .notDetermined: return "notDetermined"
  case .restricted: return "restricted"
  default: return "denied"
  }
}

func needAccess() { if status() != "granted" { fail("Yogurt doesn't have access to Calendar yet. Allow it in System Settings → Privacy & Security → Calendars.") } }

// MARK: Core Audio

func address(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}
func audioProcesses() -> [AudioObjectID] {
  var a = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}
func uint(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32 {
  var a = address(sel), v: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
  _ = AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v)
  return v
}
func bundleId(_ obj: AudioObjectID) -> String {
  var a = address(kAudioProcessPropertyBundleID), size = UInt32(MemoryLayout<CFString?>.size)
  var s: Unmanaged<CFString>?
  guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &s) == noErr, let v = s else { return "" }
  return v.takeRetainedValue() as String
}
func stringProp(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
  var a = address(sel), size = UInt32(MemoryLayout<CFString?>.size)
  var s: Unmanaged<CFString>?
  guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &s) == noErr, let v = s else { return nil }
  return v.takeRetainedValue() as String
}
func defaultInput() -> AudioObjectID {
  var a = address(kAudioHardwarePropertyDefaultInputDevice), dev = AudioObjectID(0), size = UInt32(MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &dev) == noErr else { return 0 }
  return dev
}
/// Every microphone the Mac has, the way Sound settings lists them: devices with an input stream that can be the Mac's
/// input. That leaves out call apps' own virtual devices (ZoomAudioDevice). Aggregate devices are left out too:
/// the recorder makes its own (private) one for system audio.
func inputDevices() -> [[String: Any]] {
  var a = address(kAudioHardwarePropertyDevices), size: UInt32 = 0
  let sys = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(sys, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(sys, &a, 0, nil, &size, &ids) == noErr else { return [] }
  let def = defaultInput()
  return ids.compactMap { d in
    var sa = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var ss: UInt32 = 0
    var ca = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceCanBeDefaultDevice, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var can: UInt32 = 0, cs = UInt32(MemoryLayout<UInt32>.size)
    guard AudioObjectGetPropertyDataSize(d, &sa, 0, nil, &ss) == noErr, ss > 0, uint(d, kAudioDevicePropertyIsHidden) == 0,
          AudioObjectGetPropertyData(d, &ca, 0, nil, &cs, &can) == noErr, can != 0,
          let uid = stringProp(d, kAudioDevicePropertyDeviceUID), let name = stringProp(d, kAudioObjectPropertyName) else { return nil }
    if uint(d, kAudioDevicePropertyTransportType) == kAudioDeviceTransportTypeAggregate { return nil }
    return ["uid": uid, "name": name, "default": d == def]
  }
}
func audioApps(input: Bool) -> [[String: Any]] {
  let me = ProcessInfo.processInfo.processIdentifier
  return audioProcesses().compactMap { obj in
    guard uint(obj, input ? kAudioProcessPropertyIsRunningInput : kAudioProcessPropertyIsRunningOutput) != 0 else { return nil }
    let pid = Int32(bitPattern: uint(obj, kAudioProcessPropertyPID))
    if pid == me { return nil }
    let id = bundleId(obj)
    // command-line tools have no app record or bundle id: use the program's name
    var buf = [CChar](repeating: 0, count: 256)
    _ = proc_name(pid, &buf, 256)
    let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? (id.isEmpty ? String(cString: buf) : id)
    return ["bundleId": id, "name": name, "pid": Int(pid)]
  }
}

// MARK: permissions

func micStatus() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  default: return "notDetermined"
  }
}
/** Recording the computer's sound (Core Audio taps): TCC's own answer, 0 allowed, 1 denied, 2 not asked */
let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)
func audioCapturePermission() -> Int {
  typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
  guard let h = tcc, let sym = dlsym(h, "TCCAccessPreflight") else { return 2 }
  return unsafeBitCast(sym, to: Preflight.self)("kTCCServiceAudioCapture" as CFString, nil)
}
func requestAudioCapture() {
  typealias Request = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void
  guard let h = tcc, let sym = dlsym(h, "TCCAccessRequest") else { return }
  let done = DispatchSemaphore(value: 0)
  unsafeBitCast(sym, to: Request.self)("kTCCServiceAudioCapture" as CFString, nil) { _ in done.signal() }
  _ = done.wait(timeout: .now() + 120)
}

// MARK: music

/** Players that answer AppleScript. `tell application` would launch one that isn't running, so that is checked first. */
let players = ["com.apple.Music", "com.spotify.client"]
func running(_ id: String) -> Bool { !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty }
/**
 * One command to a player, only if it's still running right now (it may have quit since the last look, and
 * `tell` would start it again). The first time, the Mac asks the person to let Yogurt control it; a no reads as nothing.
 */
func tell(_ id: String, _ what: String) -> String? {
  guard running(id) else { return nil }
  var err: NSDictionary?
  return NSAppleScript(source: "tell application id \"\(id)\" to \(what)")?.executeAndReturnError(&err).stringValue
}
func playing(_ id: String) -> Bool { tell(id, "get (player state is playing) as text") == "true" }
func pausePlayers() -> [String] {
  players.filter { playing($0) }.filter { id in
    _ = tell(id, "pause")
    return !playing(id)
  }
}
func resumePlayers(_ ids: [String]) -> [String] {
  ids.filter { players.contains($0) && running($0) && !playing($0) }.filter { id in _ = tell(id, "play"); return true }
}
/** May Yogurt control this player? ask: show the Mac's question if it hasn't been answered. Never launches it. */
func automation(_ id: String, ask: Bool) -> String {
  var target = AEAddressDesc()
  let created = id.withCString { AECreateDesc(typeApplicationBundleID, $0, strlen($0), &target) }
  guard created == noErr else { return "unknown" }
  defer { AEDisposeDesc(&target) }
  switch AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, ask) {
  case noErr: return "granted"
  case OSStatus(errAEEventNotPermitted): return "denied"
  default: return "unknown"
  }
}
func playerStatus(ask: Bool) -> [[String: String]] {
  players.filter(running).map { ["id": $0, "status": automation($0, ask: ask)] }
}

/** The active tab title via AppleScript, or Firefox's focused window via Accessibility. Never launches a browser. */
func browserTitle(_ id: String) -> String? {
  if id == "org.mozilla.firefox" {
    guard AXIsProcessTrusted(), let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first else { return nil }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.2)
    guard let window = axAttr(root, kAXFocusedWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() else { return nil }
    return axText(axAttr(window as! AXUIElement, kAXTitleAttribute))
  }
  let safari = id == "com.apple.Safari"
  guard ["com.google.Chrome", "company.thebrowser.Browser", "com.ardia.browser", "company.thebrowser.dia", "com.microsoft.edgemac", "com.brave.Browser", "com.apple.Safari"].contains(id),
        !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty else { return nil }
  let src = "tell application id \"\(id)\" to get " + (safari ? "name of current tab of front window" : "title of active tab of front window")
  var err: NSDictionary?
  return NSAppleScript(source: src)?.executeAndReturnError(&err).stringValue
}

// MARK: names from calls (Accessibility)

/**
 * Who is in a call and who is talking, as the call app shows it: its meeting windows copied out of the accessibility
 * tree, read-only (nothing is clicked or changed in the app). Only the call app Yogurt was told about, the frontmost
 * one first. Yogurt reads the tree (src/main/callNames/parse.ts). Chromium and Electron build a page's tree only when
 * an assistive app asks, so they are asked the way screen readers do (AXManualAccessibility): see askTree.
 */
let axKeys = [kAXRoleAttribute, kAXSubroleAttribute, kAXDescriptionAttribute, kAXTitleAttribute, kAXValueAttribute, kAXIdentifierAttribute, "AXDOMClassList", kAXChildrenAttribute, kAXSizeAttribute] as [String]
let chromium: Set<String> = ["com.google.Chrome", "company.thebrowser.Browser", "com.ardia.browser", "company.thebrowser.dia", "com.brave.Browser", "com.microsoft.edgemac", "com.microsoft.teams", "com.microsoft.teams2"]
var askedTree = Set<pid_t>()

/// Asks a Chromium or Electron app to build its page's accessibility tree, once per process. A browser is asked only
/// once a window is a Meet call. Teams is asked before looking: a Teams window counts as a call only by its Leave or
/// Mute button, and Teams shows those only once asked, so asking afterwards never finds a call (#111).
func askTree(_ app: AXUIElement, _ r: NSRunningApplication, force: Bool = false) {
  guard let id = r.bundleIdentifier, chromium.contains(id), !askedTree.contains(r.processIdentifier) else { return }
  guard force || id.hasPrefix("com.microsoft.teams") else { return }
  let manual = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  // AXManualAccessibility is Electron's. Chrome, and the new Teams (Chromium in a web view, not Electron), can ignore it
  // and show only their own frame, never the page: a Meet call read 0 names that way, and a Teams call never had a Leave
  // button (#138). Screen readers ask with AXEnhancedUserInterface, which Chromium honours. It can slow window
  // animations in that app, so it is turned back off when the watch ends (resetTrees).
  let asked = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  if asked == .success { enhanced.append(r.processIdentifier) }
  // a busy app (Teams joining a call) can time out: it is asked again on the next reading until it answers
  if manual == .success || asked == .success { askedTree.insert(r.processIdentifier) }
  else { lastControlLook = "asking for the tree failed (\(asked.rawValue))" }
}

/// the browsers asked with AXEnhancedUserInterface, to turn it back off when the watch ends
var enhanced: [pid_t] = []
func resetTrees() {
  for pid in enhanced { AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXEnhancedUserInterface" as CFString, kCFBooleanFalse) }
  enhanced = []
}

func axAttr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func axText(_ v: AnyObject?) -> String? {
  guard let s = v as? String, !s.isEmpty else { return nil }
  return s.count > 300 ? String(s.prefix(300)) : s
}

/** one element and what is under it, depth and element count bounded (Zoom's toolbar lists itself as its own child) */
func axCopy(_ e: AXUIElement, depth: Int, maxDepth: Int, budget: inout Int, zoom: Bool) -> [String: Any] {
  budget -= 1
  var raw: CFArray?
  AXUIElementCopyMultipleAttributeValues(e, axKeys as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
  let vals = (raw as? [AnyObject]) ?? []
  // a missing attribute comes back as an AXValue error: only real values count
  func at(_ i: Int) -> AnyObject? {
    guard i < vals.count else { return nil }
    let v = vals[i]
    if CFGetTypeID(v) == AXValueGetTypeID() && AXValueGetType(v as! AXValue) == .axError { return nil }
    return v
  }
  var n: [String: Any] = [:]
  let role = axText(at(0)) ?? ""
  n["r"] = role
  if let x = axText(at(1)) { n["s"] = x }
  if let x = axText(at(2)) { n["d"] = x }
  if let x = axText(at(3)) { n["t"] = x }
  // what someone types is never copied
  if role != "AXTextField" && role != "AXTextArea", let x = axText(at(4)) { n["v"] = x }
  if let x = axText(at(5)) { n["i"] = x }
  if let c = at(6) as? [String], !c.isEmpty { n["c"] = Array(c.prefix(20)) }
  if role == "AXTabGroup", let size = at(8), CFGetTypeID(size) == AXValueGetTypeID() {
    var sz = CGSize.zero
    if AXValueGetValue(size as! AXValue, .cgSize, &sz) { n["w"] = Int(sz.width); n["h"] = Int(sz.height) }
  }
  // a Zoom tile's description ("Name, Computer audio muted, …") says it all; its children are buttons.
  // The gallery around the tiles is also a tab group ("Gallery view"), so only a described list stops the walk.
  if zoom && role == "AXTabGroup", let d = n["d"] as? String, d.contains(",") { return n }
  guard depth < maxDepth, let kids = at(7) as? [AXUIElement], !kids.isEmpty else { return n }
  var out: [[String: Any]] = []
  for k in kids {
    if budget <= 0 { break }
    out.append(axCopy(k, depth: depth + 1, maxDepth: maxDepth, budget: &budget, zoom: zoom))
  }
  n["k"] = out
  return n
}

/** the windows of a call app that hold the call */
let callControls: Set<String> = ["leave", "leave call", "hang up", "end call", "mute mic", "unmute mic", "close participants pane"]

/// Whether one element is a control only a call has: by its label ("Leave", "Leave (⌘⇧H)") or, in Teams, its page id
func isCallControl(_ e: AXUIElement) -> Bool {
  if axText(axAttr(e, "AXDOMIdentifier")) == "hangup-button" { return true }
  for key in [kAXDescriptionAttribute, kAXTitleAttribute] as [String] {
    // a label can carry its shortcut: "Leave (⌘⇧H)"
    if let s = axText(axAttr(e, key)) {
      let plain = s.replacingOccurrences(of: #"\s*\([^)]*\)\s*$"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces).lowercased()
      if callControls.contains(plain) { return true }
    }
  }
  return false
}

/// What the last look for call controls found, for the log when no window is a call (#111)
var lastControlLook = ""

/// Chromium's own search of a page for its buttons, in one call
func searchButtons(_ e: AXUIElement) -> (AXError, [AXUIElement]) {
  let predicate: [String: Any] = ["AXSearchKey": "AXButtonSearchKey", "AXResultsLimit": 500, "AXDirection": "AXDirectionNext", "AXImmediateDescendantsOnly": false, "AXVisibleOnly": false]
  var found: AnyObject?
  let err = AXUIElementCopyParameterizedAttributeValue(e, "AXUIElementsForSearchPredicate" as CFString, predicate as CFTypeRef, &found)
  return (err, (found as? [AXUIElement]) ?? [])
}

/// Whether a window has a button that only a call has. A Teams meeting window is a whole web page: its Leave button sits
/// thousands of elements in, past any walk that stays cheap (#111). Chromium can search its own page for buttons in one
/// call, so that comes first; a walk of at most `budget` elements is the fallback. The window itself can refuse the
/// search while the page in it (its AXWebArea) answers, so the walk searches the first pages it meets (#138).
func hasCallControl(_ w: AXUIElement, budget: Int = 1500) -> Bool {
  var note: String
  let (err, buttons) = searchButtons(w)
  if err == .success {
    if buttons.contains(where: isCallControl) { return true }
    note = "search saw buttons, none a call control"
  } else {
    note = "search unavailable (\(err.rawValue))"
  }
  var left = budget, queue = [w], pages = 0
  while !queue.isEmpty && left > 0 {
    let e = queue.removeFirst(); left -= 1
    let role = axText(axAttr(e, kAXRoleAttribute)) ?? ""
    if (role == "AXButton" || role == "AXMenuItem" || role == "AXCheckBox") && isCallControl(e) { return true }
    if role == "AXWebArea" && err != .success && pages < 2 {
      pages += 1
      let (pageErr, pageButtons) = searchButtons(e)
      if pageButtons.contains(where: isCallControl) { return true }
      note += pageErr == .success ? "; page search saw buttons, none a call control" : "; page search unavailable (\(pageErr.rawValue))"
    }
    queue.append(contentsOf: (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [])
  }
  // no page in the window at all means the app never built it: what an unasked Chromium shows (#138)
  note += left <= 0 ? "; walk stopped at \(budget) elements" : pages == 0 ? "; walk saw the whole window, no page in it" : "; walk saw the whole window"
  // every window looked at, each said once, so the log says what each one gave
  if !lastControlLook.contains(note) { lastControlLook += (lastControlLook.isEmpty ? "" : " | ") + note }
  return false
}

func isMeetTitle(_ t: String) -> Bool { t.range(of: #"\bMeet\b"#, options: .regularExpression) != nil }

/// The call windows, and the tab title when the one window was chosen by it because its accessibility title does not say Meet (Ardia's is "Ardia").
func callWindows(_ app: AXUIElement, _ id: String) -> (wins: [AXUIElement], tab: String?) {
  let all = (axAttr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  if id == "us.zoom.xos" {
    return (all.filter { w in
      let ident = axText(axAttr(w, kAXIdentifierAttribute)) ?? "", title = axText(axAttr(w, kAXTitleAttribute)) ?? ""
      // while the person shares their screen Zoom hides the meeting window and shows its floating video window
      // ("zoom floating video window"), which still shows the tiles and who is talking
      return ident.hasPrefix("zm.meeting") || title.hasPrefix("Zoom Meeting") || title.hasPrefix("Zoom Webinar") || title == "zoom floating video window"
    }, nil)
  }
  // Teams keeps its chat and calendar in windows shaped like the call's: only a window with a call control (Leave,
  // Mute) is a call, so an open chat can't hide a call in another app (#72). The same controls as Linux (calls.rs).
  // Each window is asked for its page too, one cheap call each: that made Ardia build its page (#123), and the app-wide
  // ask alone left Teams with no Leave button (#138).
  if id.hasPrefix("com.microsoft.teams") {
    for w in all.prefix(8) { AXUIElementSetAttributeValue(w, "AXManualAccessibility" as CFString, kCFBooleanTrue) }
    return (all.filter { hasCallControl($0) }, nil)
  }
  // Webex's meeting surfaces have stable accessibility identifiers; exclude its home window so it cannot hide another
  // call app when a recording was started by hand.
  if id == "Cisco-Systems.Spark" || id == "com.cisco.webexmeetingsapp" {
    return (all.filter { w in
      let ident = axText(axAttr(w, kAXIdentifierAttribute)) ?? ""
      return ident == "FloatingMediaWindow" || ident == "PopOutWindow"
    }, nil)
  }
  // a browser: only windows whose front tab is a Meet call
  let meet = all.filter { w in isMeetTitle(axText(axAttr(w, kAXTitleAttribute)) ?? "") }
  if !meet.isEmpty || !chromium.contains(id) { return (meet, nil) }
  // Ardia names its windows "Ardia": the Meet words are only in the tab title, which AppleScript reads, and the tab
  // belongs to the focused window (#123)
  guard let title = browserTitle(id), isMeetTitle(title),
        let w = axAttr(app, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return ([], nil) }
  return ([w as! AXUIElement], title)
}

/// The app a process on the mic belongs to: itself, or the app above it (Zoom's CptHost runs under zoom.us)
func owningApp(_ pid: pid_t, ids: [String]) -> NSRunningApplication? {
  var pid = pid
  for _ in 0..<8 {
    if let r = NSRunningApplication(processIdentifier: pid), let id = r.bundleIdentifier, ids.contains(id) { return r }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_ppid > 1 else { return nil }
    pid = pid_t(info.pbi_ppid)
  }
  return nil
}

func watchCalls(every: Int, ids: [String], pids: [pid_t] = []) {
  // Yogurt closes stdin to stop the watch (and a crashed Yogurt closes it too)
  DispatchQueue.global().async { _ = FileHandle.standardInput.readDataToEndOfFile(); DispatchQueue.main.sync { resetTrees() }; exit(0) }
  let line = { (v: [String: Any]) in
    guard let d = try? JSONSerialization.data(withJSONObject: v) else { return }
    FileHandle.standardOutput.write(d); FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  }
  // Teams windows that are no call are pictured once, a few readings in (once asked, a page takes a moment to build), so
  // the log shows what Teams gives when its call is missed (#138)
  var misses = 0
  while true {
    let started = Date()
    let t = Int(started.timeIntervalSince1970 * 1000)
    if !AXIsProcessTrusted() {
      line(["t": t, "error": "not-trusted"])
    } else {
      // the frontmost of the apps asked about that shows a call, else the first one that does
      lastControlLook = ""
      let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
      // With the processes on the mic given, only their apps: two Zoom meetings are two processes, and the one not
      // being recorded must never give this meeting its names (#98)
      let running = (pids.isEmpty ? ids.compactMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0).first } : pids.compactMap { owningApp($0, ids: ids) })
        .sorted { a, _ in a.processIdentifier == front }
      var found: (NSRunningApplication, AXUIElement, [AXUIElement], String?)?
      var teams: (String, AXUIElement)?
      for r in running {
        let app = AXUIElementCreateApplication(r.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 0.3)
        askTree(app, r)
        let (wins, tab) = callWindows(app, r.bundleIdentifier ?? "")
        if !wins.isEmpty { found = (r, app, wins, tab); break }
        if teams == nil, let id = r.bundleIdentifier, id.hasPrefix("com.microsoft.teams") { teams = (id, app) }
      }
      if let (target, app, wins, tab) = found, let id = target.bundleIdentifier {
        askTree(app, target, force: true)
        // Asking the whole browser can still leave only its tabs and sidebar; asking the window itself makes it build
        // the page (tested on a live Meet call in Ardia, #123). It is one cheap call, so every reading asks again.
        if chromium.contains(id) && !id.hasPrefix("com.microsoft.teams") {
          for w in wins.prefix(4) { AXUIElementSetAttributeValue(w, "AXManualAccessibility" as CFString, kCFBooleanTrue) }
        }
        let zoom = id == "us.zoom.xos"
        var budget = zoom ? 1500 : 4000
        // the tab title belongs to the window that was focused when it was read
        let focused = axAttr(app, kAXFocusedWindowAttribute)
        let out = wins.prefix(4).map { w -> [String: Any] in
          var o: [String: Any] = ["tree": axCopy(w, depth: 0, maxDepth: zoom ? 14 : 40, budget: &budget, zoom: zoom)]
          // The parser skips a window whose title does not say Meet. Ardia's accessibility title is the app name, so the tab title is what gets written.
          let axTitle = axText(axAttr(w, kAXTitleAttribute)) ?? ""
          var title = axTitle
          if !isMeetTitle(axTitle), let tab, let focused, CFEqual(w, focused) { title = tab }
          if !title.isEmpty { o["title"] = title }
          if let x = axText(axAttr(w, kAXIdentifierAttribute)) { o["id"] = x }
          return o
        }
        line(["t": t, "app": id, "windows": out])
      } else {
        // which windows were looked at and how, so a log can say why a call was missed (#111)
        var o: [String: Any] = ["t": t, "error": running.isEmpty ? "not-running" : lastControlLook.isEmpty ? "no-call-window" : "no-call-window (\(lastControlLook))"]
        if let (id, app) = teams {
          misses += 1
          if misses == 10 {
            var budget = 1500
            o["app"] = id
            o["windows"] = ((axAttr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).prefix(4).map { w -> [String: Any] in
              var x: [String: Any] = ["tree": axCopy(w, depth: 0, maxDepth: 40, budget: &budget, zoom: false)]
              if let title = axText(axAttr(w, kAXTitleAttribute)) { x["title"] = title }
              return x
            }
          }
        }
        line(o)
      }
    }
    // a slow app (a big page) is read less often, so the reading never takes much of the Mac
    let took = Date().timeIntervalSince(started)
    // the run loop turns meanwhile, so the frontmost app stays current
    RunLoop.current.run(until: Date(timeIntervalSinceNow: max(Double(every) / 1000, took * 2)))
  }
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "calendar-status":
  out(["status": status()])
case "calendar-auth":
  let done = DispatchSemaphore(value: 0)
  if #available(macOS 14.0, *) { store.requestFullAccessToEvents { _, _ in done.signal() } }
  else { store.requestAccess(to: .event) { _, _ in done.signal() } }
  _ = done.wait(timeout: .now() + 120)
  out(["status": status()])
case "calendars":
  needAccess()
  out(store.calendars(for: .event).map { c in
    var row = ["id": c.calendarIdentifier, "name": c.title, "source": c.source.title]
    if let color = NSColor(cgColor: c.cgColor)?.usingColorSpace(.sRGB) {
      row["color"] = String(format: "#%02X%02X%02X", Int((color.redComponent * 255).rounded()), Int((color.greenComponent * 255).rounded()), Int((color.blueComponent * 255).rounded()))
    }
    return row
  }.sorted { ($0["source"]! + $0["name"]!) < ($1["source"]! + $1["name"]!) })
case "events":
  needAccess()
  guard args.count >= 3 else { fail("events FROM TO") }
  let from = date(args[1]), to = date(args[2])
  // ask the Mac to fetch new changes from Google, iCloud and Exchange now rather than on its own schedule (often
  // 15 minutes); it syncs in the background, so an event added elsewhere shows on the next read, a minute later at most
  store.refreshSourcesIfNecessary()
  let found = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
    .filter { !$0.isAllDay && $0.status != .canceled }
    .sorted { $0.startDate < $1.startDate }
  // A week of hidden calendars can fill the usual 200 rows before the next visible meeting.
  let events = args.dropFirst(3).contains("--full-range") ? found[...] : found.prefix(200)
  out(events.map { e in
    var o: [String: Any] = [
      "id": (e.eventIdentifier ?? e.title ?? "event") + ":" + iso.string(from: e.startDate),
      "title": e.title ?? "", "start": iso.string(from: e.startDate), "end": iso.string(from: e.endDate), "calendar": e.calendar.title,
      "calendarId": e.calendar.calendarIdentifier, "calendarSource": e.calendar.source.title,
    ]
    if let external = e.calendarItemExternalIdentifier, !external.isEmpty { o["externalId"] = external }
    if let l = e.location, !l.isEmpty { o["location"] = l }
    if let n = e.notes, !n.isEmpty { o["notes"] = String(n.prefix(2000)) }
    if let u = e.url { o["url"] = u.absoluteString }
    // the person using this Mac, apart: their address says which company they are with (Yogurt spells it right)
    if let me = e.attendees?.first(where: { $0.isCurrentUser }) {
      if me.url.absoluteString.hasPrefix("mailto:") { o["me"] = String(me.url.absoluteString.dropFirst(7)) }
      if me.participantStatus == .declined { o["declined"] = true }
    }
    // everyone but the person using this Mac
    o["attendees"] = (e.attendees ?? []).filter { !$0.isCurrentUser }.prefix(50).map { a -> [String: Any] in
      let mail = a.url.absoluteString.hasPrefix("mailto:") ? String(a.url.absoluteString.dropFirst(7)) : nil
      return ["name": a.name ?? mail ?? "", "email": mail as Any? ?? NSNull()]
    }
    return o
  })
case "mic-apps":
  out(audioApps(input: true))
case "running-apps":
  out(args.dropFirst().filter(running))
case "browser-title":
  guard args.count >= 2 else { fail("browser-title BUNDLE_ID") }
  out(["title": browserTitle(args[1]) as Any? ?? NSNull()])
case "permissions":
  // Automation preflights can wait indefinitely on a player; onboarding does not use their result.
  out(["mic": micStatus(), "systemAudio": audioCapturePermission(), "calendar": status(), "accessibility": AXIsProcessTrusted()])
case "media-auth":
  out(["players": playerStatus(ask: true)])
case "mic-auth":
  if micStatus() == "notDetermined" {
    let done = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { _ in done.signal() }
    _ = done.wait(timeout: .now() + 120)
  }
  out(["status": micStatus()])
case "audio-auth":
  if audioCapturePermission() == 2 { requestAudioCapture() }
  out(["status": audioCapturePermission()])
case "media-pause":
  out(["paused": pausePlayers()])
case "media-resume":
  out(["resumed": resumePlayers(Array(args.dropFirst()))])
case "ax-auth":
  out(["trusted": AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)])
case "call-watch":
  guard args.count >= 3, let every = Int(args[1]) else { fail("call-watch MS [--pid N]... BUNDLE_ID...") }
  var rest = Array(args.dropFirst(2)), pids: [pid_t] = []
  while rest.count >= 2, rest[0] == "--pid", let pid = pid_t(rest[1]) { pids.append(pid); rest.removeFirst(2) }
  watchCalls(every: max(100, every), ids: rest, pids: pids)
case "mic-devices":
  out(["devices": inputDevices()])
default:
  fail("usage: yogurt-mac calendar-status | calendar-auth | events FROM TO | mic-apps | running-apps ID... | browser-title ID | permissions | media-auth | mic-auth | audio-auth | media-pause | media-resume ID... | mic-devices | ax-auth | call-watch MS [--pid N]... ID...")
}
