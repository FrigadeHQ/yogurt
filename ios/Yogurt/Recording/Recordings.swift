@preconcurrency import AVFoundation
import os
import SwiftUI
import UIKit
import UserNotifications
import YogurtKit

private let log = Logger(subsystem: "so.yogurt.ios", category: "recording")

/// Where recordings made on this iPhone are kept until the computer has them.
enum RecordingsFolder {
    static var url: URL { URL.applicationSupportDirectory.appending(path: "Yogurt/Recordings", directoryHint: .isDirectory) }

    /// Created readable while the phone is locked, as long as a file was opened before: a meeting goes on in a pocket.
    static func make() throws -> URL {
        let url = url
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                                attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUnlessOpen], ofItemAtPath: url.path)
        return url
    }

    static func progressURL(_ id: String) -> URL { url.appending(path: "\(id).json") }
}

/// One meeting being recorded: the audio, the live transcript, My notes typed meanwhile, and Stop, which saves it as a
/// meeting on Home. What's recorded is kept beside the audio as it goes, so nothing is lost if Yogurt is killed.
@MainActor @Observable
final class RecordingController {
    private(set) var state = RecordingState()
    private(set) var transcript = LiveTranscript()
    var myNotes = "" { didSet { if myNotes != oldValue { scheduleSave() } } }
    /// a sentence about the live transcript (downloading the language, turned off) or space running low
    private(set) var transcriptNotice: String?
    let id = UUID().uuidString.lowercased()
    private(set) var startedAt = Date()
    /// the spoken language picked when it started: the transcript, the draft notes and the computer all use it
    let language: Locale

    init(language: Locale = Spoken.current) { self.language = language }

    @ObservationIgnored private let recorder = Recorder()
    @ObservationIgnored private let relay = TranscriberRelay()
    @ObservationIgnored private var folder: URL?
    @ObservationIgnored private var saving: Task<Void, Never>?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var resuming: Task<Void, Never>?
    @ObservationIgnored private weak var model: AppModel?
    #if DEBUG
    @ObservationIgnored private var previewLevel: Double?
    #endif

    /// the recording in progress, so a recovery at launch never takes it
    static private(set) var liveId: String?
    /// below this the recording doesn't start; below `lowSpace` it warns (64 kbps is about 30 MB an hour)
    private static let noSpace: Int64 = 50_000_000
    private static let lowSpace: Int64 = 200_000_000
    private static let pausedNotification = "recording-paused"

    var title: String { S.meetingAt(Format.time(startedAt)) }

    /// The meter's level now, read each frame.
    var level: Double {
        #if DEBUG
        if let previewLevel { return previewLevel }
        #endif
        return recorder.level
    }

    func start(model: AppModel) async {
        guard state.begin() else { return }
        self.model = model
        if AVAudioApplication.shared.recordPermission == .undetermined { _ = await AVAudioApplication.requestRecordPermission() }
        guard AVAudioApplication.shared.recordPermission == .granted else { state.fail(S.micOff); return }
        // asked before the recording starts, so the prompt never sits over a meeting being recorded: it's how Yogurt
        // says so if a call pauses the recording while the phone is in a pocket
        let center = UNUserNotificationCenter.current()
        if await center.notificationSettings().authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
        }
        let notificationsOff = await center.notificationSettings().authorizationStatus == .denied
        let space = freeSpace()
        if let space, space < Self.noSpace { state.fail(S.recordingNoSpace); return }
        if let space, space < Self.lowSpace { transcriptNotice = S.recordingLowSpace } else if notificationsOff { transcriptNotice = S.notificationsOff }
        do {
            let folder = try RecordingsFolder.make()
            self.folder = folder
            recorder.events = Recorder.Events(
                interrupted: { [weak self] began in self?.interrupted(began) },
                failed: { [weak self] message in Task { await self?.stopAfterFailure(message) } })
            let relay = relay
            recorder.onBuffer = { relay.append($0) }
            try recorder.start(writingTo: folder.appending(path: "\(id).m4a"))
        } catch {
            log.error("recording didn't start: \(String(describing: error), privacy: .public)")
            state.fail(S.recordingCantStart)
            return
        }
        startedAt = Date()
        Self.liveId = id
        _ = state.started(at: startedAt)
        saveProgress()
        // what's been heard is saved every few seconds, My notes a moment after typing
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                self?.saveProgress()
            }
        }
        let events = TranscriberEvents(
            result: { [weak self] text, start, end, final in self?.transcript.update(text, startMs: start, endMs: end, isFinal: final) },
            notice: { [weak self] in self?.transcriptNotice = $0 })
        Task { [relay, language] in await LiveTranscription.start(locale: language, events: events, relay: relay) }
    }

    func pause() {
        guard state.pause(.byYou, at: Date()) else { return }
        recorder.pause()
        saveProgress()
    }

    func resume() {
        guard state.resume(at: Date()) else { return }
        do {
            try recorder.resume()
            clearPausedNotification()
        } catch {
            log.error("resume failed: \(String(describing: error), privacy: .public)")
            _ = state.pause(.interrupted, at: Date())
        }
    }

    /// Yogurt is on screen again (opened from the notification, or unlocked): a recording a call paused picks up.
    func cameBack() {
        guard state.phase == .paused(.interrupted) else { return }
        resume()
    }

    private func interrupted(_ began: Bool) {
        if began {
            guard state.pause(.interrupted, at: Date()) else { return }
            recorder.pause()
            saveProgress()
            if UIApplication.shared.applicationState != .active { postPausedNotification() }
        } else if state.interruptionEnded(at: Date()) {
            // the microphone can take a moment to be free again after a call
            resuming?.cancel()
            resuming = Task { [weak self] in
                for delay in [0.0, 0.5, 1.5, 3] {
                    if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
                    guard let self, !Task.isCancelled, self.state.phase == .recording else { return }
                    do { try self.recorder.resume(); self.clearPausedNotification(); return } catch {
                        log.error("resume after a call failed: \(String(describing: error), privacy: .public)")
                    }
                }
                guard let self, self.state.phase == .recording else { return }
                _ = self.state.pause(.interrupted, at: Date())
                if UIApplication.shared.applicationState != .active { self.postPausedNotification() }
            }
        }
    }

    /// Saves it as a meeting and starts its notes. Returns the meeting's id, or nil if it couldn't be saved (it is then
    /// found again at the next launch).
    func stop(model: AppModel) async -> String? {
        guard state.stop(at: Date()) else { return nil }
        return await finish(model: model)
    }

    /// The audio couldn't be written any more (the disk is full, the audio system restarted): what was saved is
    /// kept as a meeting, and the screen says why it stopped.
    private func stopAfterFailure(_ message: String) async {
        guard state.stop(at: Date()), let model else { return }
        if await finish(model: model) != nil { state.fail(message + " " + S.recordingKeptAsMeeting) }
    }

    private func finish(model: AppModel) async -> String? {
        ticker?.cancel(); saving?.cancel(); resuming?.cancel()
        clearPausedNotification()
        let durationMs = await recorder.stop()
        if let t = relay.current { await waitAtMost(seconds: 6) { await t.finish() } }
        let progress = currentProgress()
        writeProgress(progress)
        guard let folder else { return nil }
        let rec = progress.recording(in: folder, title: title, durationMs: durationMs > 0 ? durationMs : nil)
        // a recording isn't live once Stop is pressed: if saving fails, the next visit to Home finds it again
        Self.liveId = nil
        do {
            try model.store.saveLocalRecording(rec)
        } catch {
            log.error("saving the recording failed: \(String(describing: error), privacy: .public)")
            state.fail(S.recordingSaveFailed)
            return nil
        }
        try? FileManager.default.removeItem(at: RecordingsFolder.progressURL(id))
        _ = state.finished()
        model.edited()
        // first, so the upload waits for the draft notes and title; paired, it goes to the computer now if they're
        // connected, else the next time they are
        PhoneDrafts.shared.write(rec.id, model: model)
        Task { await model.engine.syncNow() }
        return rec.id
    }

    /// Stops and throws the recording away: its audio, transcript and notes.
    func discard() async {
        guard state.stop(at: Date()) else { return }
        ticker?.cancel(); saving?.cancel(); resuming?.cancel()
        clearPausedNotification()
        _ = await recorder.stop()
        if let t = relay.current { await waitAtMost(seconds: 1) { await t.finish() } }
        Self.liveId = nil
        if let folder {
            try? FileManager.default.removeItem(at: folder.appending(path: "\(id).m4a"))
            try? FileManager.default.removeItem(at: RecordingsFolder.progressURL(id))
        }
        _ = state.finished()
    }

    private func freeSpace() -> Int64? {
        (try? URL.applicationSupportDirectory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage
    }

    private func postPausedNotification() {
        let content = UNMutableNotificationContent()
        content.title = S.recordingPausedTitle
        content.body = S.recordingPausedBody
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: Self.pausedNotification, content: content, trigger: nil))
    }

    private func clearPausedNotification() {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [Self.pausedNotification])
        center.removePendingNotificationRequests(withIdentifiers: [Self.pausedNotification])
    }

    #if DEBUG
    func startPreview() {
        _ = state.begin()
        startedAt = Date().addingTimeInterval(-754)
        _ = state.started(at: startedAt)
        previewLevel = 0.55
    }
    func previewLine(_ text: String, at ms: Int) { transcript.update(text, startMs: ms, endMs: ms + 5000, isFinal: true) }
    func previewVolatile(_ text: String) { transcript.update(text, startMs: 0, endMs: 0, isFinal: false) }
    #endif

    // MARK: - Kept as it goes

    private func scheduleSave() {
        saving?.cancel()
        saving = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            self?.saveProgress()
        }
    }

    private func currentProgress() -> RecordingInProgress {
        var p = RecordingInProgress(id: id, startedAt: startedAt, audioFile: "\(id).m4a")
        p.myNotes = myNotes
        p.lines = transcript.settled
        p.language = language.identifier(.bcp47)
        return p
    }

    private func saveProgress() {
        guard state.isLive || state.phase == .stopping else { return }
        writeProgress(currentProgress())
    }

    private func writeProgress(_ p: RecordingInProgress) {
        do {
            try JSONEncoder().encode(p).write(to: RecordingsFolder.progressURL(id), options: [.atomic, .completeFileProtectionUnlessOpen])
        } catch {
            log.error("keeping the recording's progress failed: \(String(describing: error), privacy: .public)")
        }
    }
}

/// Draft notes written on this iPhone by Apple's model, and recordings a crash left behind.
@MainActor @Observable
final class PhoneDrafts {
    static let shared = PhoneDrafts()

    /// meetings whose notes are being written now
    private(set) var writing: Set<String> = []
    @ObservationIgnored private var tried: Set<String> = []

    func isWriting(_ id: String) -> Bool { writing.contains(id) }

    /// Writes the notes and a title, unless Apple's model isn't on this iPhone or doesn't write the language it was
    /// recorded in (the computer writes them instead; on its own, the transcript is kept).
    func write(_ id: String, model: AppModel) {
        guard !writing.contains(id), let rec = model.store.localRecordings().first(where: { $0.id == id }),
              AppleIntelligence.available(for: rec.spokenLocale) else { return }
        tried.insert(id)
        writing.insert(id)
        model.edited()
        Task {
            await run(id, model: model)
            writing.remove(id)
            model.edited()
            // it waited for these notes to go to the computer
            await model.engine.syncNow()
        }
    }

    private func run(_ id: String, model: AppModel) async {
        guard let rec = model.store.localRecordings().first(where: { $0.id == id }) else { return }
        let summarizer = AppleIntelligence.summarizer(locale: rec.spokenLocale)
        let segments = rec.segments
        var summary: String?
        do {
            summary = try await summarizer.summarize(transcript: segments, myNotes: model.store.notes(id)?.mine ?? rec.myNotes)
        } catch {
            log.error("draft notes failed: \(String(describing: error), privacy: .public)")
            // Apple's model doesn't run in the background: try again when Yogurt is back on screen
            if UIApplication.shared.applicationState != .active { tried.remove(id) }
        }
        let title = try? await summarizer.title(notes: summary, transcript: segments)
        // read again: it may have been uploaded or renamed meanwhile
        guard var latest = model.store.localRecordings().first(where: { $0.id == id }) else { return }
        if let summary { latest.summary = summary }
        if let title, model.store.meeting(id)?.title == rec.title, latest.titleSource == .default {
            latest.title = title
            latest.titleSource = .model
            // it reached the computer first (Yogurt opened while it was still to go): the title follows as a rename
            if latest.uploadedAt != nil { try? model.store.enqueue(PendingOp(Op(kind: .rename, meetingId: id, title: title))) }
        }
        guard summary != nil || latest.title != rec.title else { return }
        do { try model.store.saveLocalRecording(latest) } catch {
            log.error("saving draft notes failed: \(String(describing: error), privacy: .public)")
            tried.remove(id)
        }
    }

    /// At launch and when Yogurt comes back: recordings a crash left behind become meetings, notes not written yet
    /// are written, and audio the computer has imported is let go.
    func resume(model: AppModel) async {
        await recover(model: model)
        for rec in model.store.localRecordings() {
            if rec.uploadedAt != nil {
                // the computer has it for good (imported); the phone's copy was only kept until then
                if FileManager.default.fileExists(atPath: rec.audioURL.path) { try? FileManager.default.removeItem(at: rec.audioURL) }
                continue
            }
            guard rec.summary == nil, !tried.contains(rec.id), model.store.notes(rec.id)?.summarySource == .phoneDraft else { continue }
            write(rec.id, model: model)
        }
    }

    private func recover(model: AppModel) async {
        let folder = RecordingsFolder.url
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file), let p = try? JSONDecoder().decode(RecordingInProgress.self, from: data),
                  p.id != RecordingController.liveId else { continue }
            let audio = folder.appending(path: p.audioFile)
            let seconds = try? await AVURLAsset(url: audio).load(.duration).seconds
            let ms = seconds.flatMap { $0.isFinite && $0 > 0 ? Int($0 * 1000) : nil }
            // killed in its first seconds: no audio could be read and nothing was heard, so there's nothing to keep
            if ms == nil && p.lines.isEmpty && p.myNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                try? FileManager.default.removeItem(at: audio)
                try? FileManager.default.removeItem(at: file)
                continue
            }
            let rec = p.recording(in: folder, title: S.meetingAt(Format.time(p.startedAt)), durationMs: ms)
            do {
                try model.store.saveLocalRecording(rec)
                try? FileManager.default.removeItem(at: file)
                log.notice("recovered recording \(p.id, privacy: .public)")
                model.edited()
            } catch {
                log.error("recovering a recording failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// The line under a phone recording's title on Home, until the computer's notes replace the draft.
    func homeDetail(for meeting: Meeting, recordings: [String: LocalRecording], model: AppModel) -> String? {
        guard let rec = recordings[meeting.id], model.store.notes(meeting.id)?.summarySource == .phoneDraft else { return nil }
        if writing.contains(meeting.id) { return "\(S.recordedHere) · \(S.writingNotes)" }
        if model.engine.status != .notPaired && rec.uploadedAt == nil { return "\(S.recordedHere) · \(S.waitingForComputer)" }
        return S.recordedHere
    }
}

/// Waits for work, but not longer than this.
private func waitAtMost(seconds: Double, _ work: @escaping @Sendable () async -> Void) async {
    let once = Once()
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        once.set(c)
        Task { await work(); once.resume() }
        Task { try? await Task.sleep(for: .seconds(seconds)); once.resume() }
    }
}

private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var c: CheckedContinuation<Void, Never>?
    func set(_ c: CheckedContinuation<Void, Never>) { lock.withLock { self.c = c } }
    func resume() { lock.withLock { c?.resume(); c = nil } }
}
