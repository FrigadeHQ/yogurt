import SwiftUI
import YogurtKit

/// Recording a meeting in the room: a big timer and a gentle level meter, the transcript fading in as people talk,
/// My notes to type meanwhile, and Stop, which saves it as a meeting. Calm like desktop's recording note.
struct RecordView: View {
    enum Tab: String, CaseIterable { case transcript, mine }

    /// called with the new meeting's id after Stop
    let saved: (String) -> Void
    var preview = false
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recording: RecordingController
    @State private var tab: Tab = .transcript
    @State private var confirmDiscard = false
    @Environment(\.scenePhase) private var phase
    @FocusState private var typing: Bool
    @Namespace private var underline

    /// language: what this recording listens in, picked beside Record on Home
    init(language: Locale = Spoken.current, saved: @escaping (String) -> Void, preview: Bool = false) {
        self.saved = saved
        self.preview = preview
        _recording = State(initialValue: RecordingController(language: language))
    }

    var body: some View {
        VStack(spacing: 0) {
            top
            if case .failed(let message) = recording.state.phase {
                failed(message)
            } else {
                tabs
                Group {
                    switch tab {
                    case .transcript: LiveTranscriptView(transcript: recording.transcript, live: recording.state.phase == .recording)
                    case .mine: notes
                    }
                }
                .frame(maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 20)
        .background(Theme.bg)
        .safeAreaInset(edge: .bottom) { controls }
        .interactiveDismissDisabled()
        .task {
            #if DEBUG
            if preview { recording.loadPreview(); return }
            #endif
            await recording.start(model: model)
        }
        .onChange(of: phase) { _, now in if now == .active { recording.cameBack() } }
    }

    // MARK: - Timer and level

    private var top: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(dotColor).frame(width: 8, height: 8)
                HStack(spacing: 4) {
                    Text(phaseLabel).font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
                        .contentTransition(.opacity)
                    // picked before it started, so here it's only said
                    Text("· " + SpokenLanguage.name(of: recording.language, in: .current))
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            .padding(.top, 18)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .overlay(alignment: .topLeading) {
                if recording.state.isLive && !confirmDiscard {
                    Button(S.discard) { withAnimation(.easeOut(duration: 0.18)) { confirmDiscard = true } }
                        .font(.subheadline)
                        .foregroundStyle(Theme.muted)
                        .frame(minHeight: 44)
                        .padding(.top, 6)
                        .accessibilityIdentifier("record-discard")
                }
            }
            TimelineView(.periodic(from: .now, by: 0.25)) { context in
                Text(elapsed(recording.state.elapsed(at: context.date)))
                    .font(.system(size: 64, weight: .light).monospacedDigit())
                    .foregroundStyle(Theme.heading)
                    .contentTransition(.numericText())
                    .accessibilityLabel(S.recordedTime)
                    .accessibilityValue(elapsed(recording.state.elapsed(at: context.date)))
            }
            LevelMeter(level: { recording.level }, still: recording.state.phase != .recording)
                .frame(height: 28)
                .accessibilityLabel(S.micLevel)
            if let notice = recording.transcriptNotice {
                Text(notice).font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                    .padding(.top, 4)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 8)
        .animation(.easeOut(duration: 0.2), value: recording.transcriptNotice)
    }

    private var dotColor: Color {
        switch recording.state.phase {
        case .recording: Theme.danger
        case .paused: Theme.muted
        default: Theme.line
        }
    }

    private var phaseLabel: String {
        switch recording.state.phase {
        case .idle, .starting: S.starting
        case .recording: S.recording
        case .paused(.byYou): S.paused
        case .paused(.interrupted): S.pausedForCall
        case .stopping, .finished: S.savingRecording
        case .failed: S.stopped
        }
    }

    // MARK: - Transcript and My notes

    /// the note's tab row: plain labels over a hairline, the chosen one underlined in purple
    private var tabs: some View {
        HStack(spacing: 22) {
            ForEach(Tab.allCases, id: \.self) { t in
                Button {
                    withAnimation(.easeOut(duration: 0.18)) { tab = t }
                    if t == .mine { typing = true } else { typing = false }
                } label: {
                    Text(t == .transcript ? S.liveTranscript : S.myNotes)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(tab == t ? Theme.ink : Theme.muted)
                        .padding(.horizontal, 2)
                        .frame(height: 40)
                        .overlay(alignment: .bottom) {
                            if tab == t {
                                Rectangle().fill(Theme.primary).frame(height: 2).matchedGeometryEffect(id: "underline", in: underline)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == t ? .isSelected : [])
                .accessibilityIdentifier("record-tab-\(t.rawValue)")
            }
            Spacer()
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private var notes: some View {
        @Bindable var recording = recording
        return ZStack(alignment: .topLeading) {
            if recording.myNotes.isEmpty {
                Text(S.myNotesWhileRecording)
                    .foregroundStyle(Theme.muted)
                    .padding(.top, 8).padding(.leading, 5)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $recording.myNotes)
                .focused($typing)
                .scrollContentBackground(.hidden)
                .foregroundStyle(Theme.ink)
                .lineSpacing(4)
                .accessibilityLabel(S.myNotes)
                .accessibilityIdentifier("record-my-notes")
        }
        .font(.body)
        .padding(.horizontal, -5)
        .padding(.top, 14)
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 18) {
            Text(message).font(.body).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
            if message == S.micOff {
                Button(S.openSettings) { Permission.openSettings() }.buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(.top, 40)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Pause and Stop

    private var controls: some View {
        Group {
            if confirmDiscard && recording.state.isLive { discardConfirm } else { buttons }
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Theme.bg)
        .animation(.easeOut(duration: 0.18), value: recording.state.phase)
        .animation(.easeOut(duration: 0.18), value: confirmDiscard)
    }

    /// asked in place, where Stop was, so it can't be hit by accident
    private var discardConfirm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(S.discardQuestion).font(.subheadline).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Button(S.keepRecording) { confirmDiscard = false }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(Theme.control, in: Capsule())
                    .accessibilityIdentifier("record-keep")
                Button(S.discard) {
                    Task {
                        await recording.discard()
                        dismiss()
                    }
                }
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(Theme.danger, in: Capsule())
                .accessibilityIdentifier("record-discard-confirm")
            }
        }
        .transition(.opacity)
    }

    private var buttons: some View {
        HStack(spacing: 14) {
            switch recording.state.phase {
            case .recording, .paused:
                Button {
                    if recording.state.isPaused { recording.resume() } else { recording.pause() }
                } label: {
                    Image(systemName: recording.state.isPaused ? "play.fill" : "pause.fill")
                        .font(.title3)
                        .foregroundStyle(Theme.ink)
                        .frame(width: 54, height: 54)
                        .background(Theme.control, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(recording.state.isPaused ? S.resume : S.pause)
                .accessibilityIdentifier("record-pause")
                Button { Task { await stop() } } label: {
                    Label(S.stop, systemImage: "stop.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .accessibilityIdentifier("record-stop")
            case .stopping, .finished:
                ProgressView().frame(height: 54).frame(maxWidth: .infinity)
            case .idle, .starting:
                Color.clear.frame(height: 54)
            case .failed:
                Button(S.close) { dismiss() }.buttonStyle(PrimaryButtonStyle()).frame(maxWidth: .infinity)
            }
        }
    }

    private func stop() async {
        typing = false
        #if DEBUG
        if preview { dismiss(); return }
        #endif
        if let id = await recording.stop(model: model) {
            dismiss()
            saved(id)
        }
    }

    private func elapsed(_ s: TimeInterval) -> String { Format.offset(Int(s * 1000)) }
}

/// The transcript as it's heard: settled lines fade in, the words still changing sit below in a softer colour.
struct LiveTranscriptView: View {
    let transcript: LiveTranscript
    let live: Bool

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if transcript.lines.isEmpty && transcript.volatile.isEmpty {
                    Text(live ? S.listening : S.transcriptWaiting)
                        .font(.subheadline).foregroundStyle(Theme.muted)
                }
                ForEach(Array(transcript.lines.enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(Format.offset(line.startMs))
                            .font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                            .frame(minWidth: 36, alignment: .leading)
                        Text(line.text).font(.body).foregroundStyle(Theme.written).lineSpacing(4)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .transition(.opacity)
                }
                if !transcript.volatile.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Color.clear.frame(width: 36, height: 1)
                        Text(transcript.volatile).font(.body).foregroundStyle(Theme.muted).lineSpacing(4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .id("volatile")
                    .transition(.opacity)
                }
            }
            .padding(.top, 16).padding(.bottom, 24)
            .animation(.easeOut(duration: 0.35), value: transcript.lines.count)
        }
        .defaultScrollAnchor(.bottom)
        .scrollIndicators(.hidden)
    }
}

/// desktop's five-bar meter: quick to rise, gentle to fall, three still dots while paused.
struct LevelMeter: View {
    /// read each frame, so the level never goes through the view's state
    let level: () -> Double
    let still: Bool
    @State private var wave = WaveBox()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let weights: [Double] = [0.5, 0.75, 1, 0.75, 0.5]
    private let bar: CGFloat = 4
    private let gap: CGFloat = 4

    var body: some View {
        TimelineView(.animation(minimumInterval: reduceMotion ? 0.1 : nil, paused: still)) { context in
            Canvas { ctx, size in
                let level = wave.step(to: still ? 0 : self.level(), at: context.date, instant: reduceMotion)
                let heights = still ? [0.0, 0, 0] : weights.map { $0 * level }
                let alpha = still ? 0.5 : 0.45 + 0.55 * level
                let width = CGFloat(heights.count) * bar + CGFloat(heights.count - 1) * gap
                for (i, v) in heights.enumerated() {
                    let h = bar + CGFloat(v) * (size.height - bar)
                    let rect = CGRect(x: (size.width - width) / 2 + CGFloat(i) * (bar + gap), y: (size.height - h) / 2, width: bar, height: h)
                    ctx.fill(Path(roundedRect: rect, cornerRadius: bar / 2), with: .color(Theme.accent.opacity(alpha)))
                }
            }
        }
        .frame(width: 5 * bar + 4 * gap + 8)
        .accessibilityHidden(true)
    }
}

/// The meter's smoothing, kept across frames without redrawing the view.
final class WaveBox {
    private var wave = Wave()
    private var last: Date?

    func step(to target: Double, at now: Date, instant: Bool) -> Double {
        wave.target = target
        let dt = min(100, (last.map { now.timeIntervalSince($0) } ?? 0) * 1000)
        last = now
        if instant { wave.step(10_000) } else { wave.step(dt) }
        return wave.level
    }
}

#if DEBUG
extension RecordingController {
    /// A made-up meeting for checking the screen in the simulator, where there's no microphone.
    func loadPreview() {
        startPreview()
        for (i, line) in ["So the plan is to ship the beta on Thursday.", "Maya, can you write the post by Wednesday?",
                          "Yes, I'll send a draft tomorrow morning.", "Great. And the pricing page needs the new tiers."].enumerated() {
            previewLine(line, at: i * 6000)
        }
        previewVolatile("Leo said he can review it on")
    }
}
#endif
