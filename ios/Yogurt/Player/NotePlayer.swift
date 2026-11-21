import AVFoundation
import Foundation
import YogurtKit

/// Plays one note's audio: this iPhone's own recording if it still has it, else the computer's, fetched on demand into
/// the caches folder. The audio session is `.playback` only while playing; the recorder sets up its own when it starts.
@MainActor @Observable
final class NotePlayer {
    enum State: Equatable {
        case loading
        /// nothing here and no computer in reach
        case nearby
        /// the computer has none for this meeting
        case noAudio
        case downloading(Double)
        case ready
        case failed(String)
    }

    private(set) var state: State = .loading
    private(set) var playing = false
    private(set) var positionMs = 0
    private(set) var durationMs = 0
    private(set) var rate = 1.0
    /// played or moved: only then is a line marked
    private(set) var touched = false
    /// the finger is on the scrubber
    var scrubbing = false

    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var item: AVPlayerItem?
    @ObservationIgnored private var tick: Any?
    @ObservationIgnored private var status: NSKeyValueObservation?
    @ObservationIgnored private var ended: Task<Void, Never>?
    @ObservationIgnored private var loading: Task<Void, Never>?
    /// a moment to jump to as soon as the audio is ready (an Ask source)
    @ObservationIgnored private var pendingSeek: Int?

    var isReady: Bool { state == .ready }

    // MARK: - Loading

    /// Finds the audio and gets it ready. Safe to call again (connected later, or Try again).
    func load(meetingId: String, model: AppModel, startAt: Int? = nil) {
        if let startAt { pendingSeek = PlayerLogic.seekMs(forLineAt: startAt) }
        guard !isReady, !isDownloading else { return }
        loading?.cancel()
        loading = Task { await run(meetingId, model) }
    }

    private var isDownloading: Bool { if case .downloading = state { true } else { false } }

    private func run(_ id: String, _ model: AppModel) async {
        let sync = model.sync
        let connected: Bool = { if case .connected = model.engine.status { true } else { false } }()
        let phone = Self.phoneFile(id, model)
        let cached = [sync.cachedAudio(meetingId: id, track: "them"), sync.cachedAudio(meetingId: id, track: "me")].compactMap { $0 }
        switch PlayerLogic.source(phoneFile: phone != nil, cached: !cached.isEmpty, connected: connected) {
        case .phone: await prepare([phone!])
        case .cached: await prepare(cached)
        case .none: state = .nearby
        case .computer:
            state = .downloading(0)
            do {
                var files: [URL] = []
                do {
                    // "them" is the call (or the room); "me" is this person's mic on a computer-recorded call
                    files.append(try await sync.audioURL(meetingId: id, track: "them", progress: { [weak self] p in self?.fetching(p * 0.85) }))
                } catch SyncError.remote("gone") {}
                self.fetching(0.85)
                if let me = try? await sync.audioURL(meetingId: id, track: "me") { files.append(me) }
                if files.isEmpty { state = .noAudio; return }
                await prepare(files)
            } catch SyncError.unplayableAudio {
                state = .failed(S.audioCantPlay)
            } catch is CancellationError {
            } catch {
                // the connection went mid-way: nearby again, or a plain failure while it is up
                if case .connected = model.engine.status { state = .failed(S.audioNotLoaded) } else { state = .nearby }
            }
        }
    }

    private func fetching(_ p: Double) { if isDownloading { state = .downloading(p) } }

    private static func phoneFile(_ id: String, _ model: AppModel) -> URL? {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "previewAudio") { return PreviewTone.url }
        #endif
        guard let rec = model.store.localRecordings().first(where: { $0.id == id && $0.uploadedAt == nil }),
              FileManager.default.fileExists(atPath: rec.audioURL.path) else { return nil }
        return rec.audioURL
    }

    private func prepare(_ files: [URL]) async {
        do {
            let asset: AVAsset
            if files.count == 1 {
                asset = AVURLAsset(url: files[0])
            } else {
                // both sides in one item, so they stay in step
                let mix = AVMutableComposition()
                for f in files {
                    let a = AVURLAsset(url: f)
                    guard let src = try await a.loadTracks(withMediaType: .audio).first,
                          let track = mix.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
                    try track.insertTimeRange(CMTimeRange(start: .zero, duration: try await a.load(.duration)), of: src, at: .zero)
                }
                asset = mix
            }
            guard try await asset.load(.isPlayable) else { state = .failed(S.audioCantPlay); return }
            let seconds = try await asset.load(.duration).seconds
            guard seconds.isFinite, seconds > 0 else { state = .failed(S.audioCantPlay); return }
            attach(AVPlayerItem(asset: asset), duration: seconds)
        } catch is CancellationError {
        } catch {
            state = .failed(S.audioCantPlay)
        }
    }

    private func attach(_ item: AVPlayerItem, duration seconds: Double) {
        let p = AVPlayer(playerItem: item)
        self.item = item
        player = p
        durationMs = Int(seconds * 1000)
        tick = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self, !self.scrubbing, t.seconds.isFinite else { return }
                self.positionMs = Int(t.seconds * 1000)
            }
        }
        // pauses that aren't ours (a call, headphones out) show too
        status = p.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            let on = player.timeControlStatus != .paused
            Task { @MainActor in self?.playing = on }
        }
        ended = Task { [weak self] in
            for await _ in NotificationCenter.default.notifications(named: .AVPlayerItemDidPlayToEndTime, object: item) {
                self?.reachedEnd()
            }
        }
        state = .ready
        if let at = pendingSeek { pendingSeek = nil; seek(to: at) }
    }

    private func reachedEnd() {
        playing = false
        positionMs = durationMs
        deactivateSession()
    }

    // MARK: - Controls

    /// Not while a meeting is being recorded: playing would take the microphone's audio session away.
    var blocked: Bool { RecordingController.liveId != nil }

    func toggle() { playing ? pause() : play() }

    func play() {
        guard let player, !blocked else { return }
        let session = AVAudioSession.sharedInstance()
        // keeps playing with the screen locked or the app in the background
        try? session.setCategory(.playback, mode: .spokenAudio)
        try? session.setActive(true)
        if positionMs >= durationMs - 50 { seek(to: 0) }
        touched = true
        player.rate = Float(rate)
        player.play()
        player.rate = Float(rate)
    }

    func pause() {
        player?.pause()
        playing = false
        deactivateSession()
    }

    /// Plays from a transcript line.
    func playFrom(lineAt ms: Int) {
        guard isReady else { return }
        seek(to: PlayerLogic.seekMs(forLineAt: ms))
        play()
    }

    func seek(to ms: Int) {
        let clamped = min(max(0, ms), durationMs)
        positionMs = clamped
        touched = true
        player?.seek(to: CMTime(value: CMTimeValue(clamped), timescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func cycleRate() {
        rate = PlayerLogic.nextRate(rate)
        if playing { player?.rate = Float(rate) }
    }

    /// leaving the note, or a recording starting
    func stop() {
        loading?.cancel()
        pause()
        if let tick { player?.removeTimeObserver(tick) }
        tick = nil
        status = nil
        ended?.cancel()
        player = nil
        item = nil
    }

    /// Lets other audio come back. Never while recording, whose own session this would pull away.
    private func deactivateSession() {
        guard RecordingController.liveId == nil else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

#if DEBUG
/// A made-up two-minute tone for screenshots (`-previewAudio YES`): there are no real recordings in the simulator.
enum PreviewTone {
    static let url: URL = {
        let file = URL.temporaryDirectory.appending(path: "preview-tone.wav")
        if !FileManager.default.fileExists(atPath: file.path) {
            let rate = 8000, seconds = 150
            var pcm = Data(capacity: rate * seconds * 2)
            for i in 0..<(rate * seconds) {
                var v = Int16(6000 * sin(Double(i) * 2 * .pi * 220 / Double(rate)))
                withUnsafeBytes(of: &v) { pcm.append(contentsOf: $0) }
            }
            var h = Data("RIFF".utf8)
            func le(_ n: Int, _ bytes: Int) { var x = UInt32(n).littleEndian; h.append(Data(bytes: &x, count: bytes)) }
            le(36 + pcm.count, 4); h.append(Data("WAVEfmt ".utf8)); le(16, 4); le(1, 2); le(1, 2); le(rate, 4); le(rate * 2, 4); le(2, 2); le(16, 2)
            h.append(Data("data".utf8)); le(pcm.count, 4)
            try? (h + pcm).write(to: file)
        }
        return file
    }()
}
#endif
