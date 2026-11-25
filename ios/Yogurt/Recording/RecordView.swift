import SwiftUI
import YogurtKit

/// Recording a meeting in the room: a timer and a gentle level meter, the transcript fading in as people talk,
/// My notes to type meanwhile, and Stop, which saves it as a meeting. Calm like desktop's recording note.
struct RecordView: View {
    enum Tab: String, CaseIterable { case transcript, mine }

    /// called with the new meeting's id after Stop
    let saved: (String) -> Void
    var preview = false
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recording = RecordingController()
    @State private var pickingLanguage = false
    @State private var tab: Tab = .transcript
    @State private var confirmDiscard = false
    @Environment(\.scenePhase) private var phase
    @FocusState private var typing: Bool

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
        .alert(S.discardQuestion, isPresented: $confirmDiscard) {
            Button(S.keepRecording, role: .cancel) {}
                .accessibilityIdentifier("record-keep")
            Button(S.discard, role: .destructive) {
                Task {
                    #if DEBUG
                    if preview { dismiss(); return }
                    #endif
                    await recording.discard()
                    dismiss()
                }
            }
            .accessibilityIdentifier("record-discard-confirm")
        }
        .sheet(isPresented: $pickingLanguage) {
            SpokenLanguageList(selection: Binding(get: { recording.spokenSelection }, set: { recording.changeLanguage(to: $0) }),
                               hint: S.forThisRecording)
                .safeAreaInset(edge: .top, spacing: 0) { SheetHeader(title: S.spokenLanguage) }
                .presentationDetents([.medium, .large])
        }
        .interactiveDismissDisabled()
        .task {
            #if DEBUG
            if preview {
                recording.loadPreview()
                pickingLanguage = UserDefaults.standard.bool(forKey: "openRecordLanguage")
                return
            }
            #endif
            await recording.start(model: model)
        }
        .onChange(of: phase) { _, now in if now == .active { recording.cameBack() } }
    }

    // MARK: - Timer and level

    private var top: some View {
        VStack(alignment: .leading, spacing: 8) {
            let languageName = SpokenLanguage.name(of: recording.language, in: .current)
            HStack {
                Button { pickingLanguage = true } label: {
                    HStack(spacing: 5) {
                        Circle().fill(dotColor).frame(width: 8, height: 8)
                        Text(phaseLabel).fontWeight(.semibold).foregroundStyle(Theme.ink)
                        Text("·").accessibilityHidden(true)
                        Text(languageName)
                        Image(systemName: "chevron.down").font(.caption2)
                    }
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Theme.card, in: Capsule())
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!recording.state.isLive)
                .accessibilityLabel(phaseLabel + ", " + S.spokenLanguage)
                .accessibilityValue(languageName)
                .accessibilityIdentifier("record-language")
                Spacer(minLength: 8)
                if recording.state.isLive {
                    Menu {
                        Button(role: .destructive) { confirmDiscard = true } label: {
                            Label(S.discard, systemImage: "trash")
                        }
                        .accessibilityIdentifier("record-discard")
                    } label: {
                        Image(systemName: "ellipsis")
                            .foregroundStyle(Theme.ink)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(S.more)
                    .accessibilityIdentifier("record-more")
                }
            }
            HStack(alignment: .center, spacing: 14) {
                TimelineView(.periodic(from: .now, by: 0.25)) { context in
                    Text(elapsed(recording.state.elapsed(at: context.date)))
                        .font(.largeTitle.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Theme.heading)
                        .contentTransition(.numericText())
                        .accessibilityLabel(S.recordedTime)
                        .accessibilityValue(elapsed(recording.state.elapsed(at: context.date)))
                }
                LevelMeter(level: { recording.level }, still: recording.state.phase != .recording)
                    .frame(height: 24)
                    .accessibilityLabel(S.micLevel)
            }
            if let notice = recording.transcriptNotice {
                Text(notice).font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                    .padding(.top, 4)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 18)
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

    private var tabs: some View {
        HStack(spacing: 2) {
            ForEach(Tab.allCases, id: \.self) { t in
                Button(t == .transcript ? S.liveTranscript : S.myNotes) {
                    withAnimation(.easeOut(duration: 0.18)) { tab = t }
                    typing = t == .mine
                }
                .buttonStyle(MeetingTabStyle(selected: tab == t))
                .accessibilityAddTraits(tab == t ? .isSelected : [])
                .accessibilityIdentifier("record-tab-\(t.rawValue)")
            }
        }
        .padding(3)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
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
        }
        .padding(.top, 40)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Pause and Stop

    private var controls: some View {
        buttons
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(Theme.bg)
            .animation(.easeOut(duration: 0.18), value: recording.state.phase)
    }

    private var buttons: some View {
        HStack(spacing: 14) {
            switch recording.state.phase {
            case .recording, .paused:
                Button {
                    if recording.state.isPaused { recording.resume() } else { recording.pause() }
                } label: {
                    Label(recording.state.isPaused ? S.resume : S.pause, systemImage: recording.state.isPaused ? "play.fill" : "pause.fill")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.ink)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 52)
                        .background(Theme.card, in: Capsule())
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
            case .failed(let message):
                if message == S.micOff {
                    Button(S.close) { dismiss() }.frame(minHeight: 44)
                    Button(S.openSettings) { Permission.openSettings() }.buttonStyle(PrimaryButtonStyle())
                } else {
                    Button(S.close) { dismiss() }.buttonStyle(PrimaryButtonStyle())
                }
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
        .defaultScrollAnchor(.top, for: .alignment)
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
