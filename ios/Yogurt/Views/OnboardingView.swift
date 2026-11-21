import SwiftUI
import YogurtKit

/// First run, modelled on desktop's Onboarding.tsx: a welcome, then one screen per idea still to ask (microphone,
/// speech recognition, the computer), each with a picture of what it does, then Ready. Every step can be put off with
/// "Not now"; Settings has them all again. Permissions already on and a computer already paired are skipped.
struct OnboardingView: View {
    enum Step: String, CaseIterable { case welcome, microphone, speech, computer, ready }

    let done: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var phase
    @Environment(\.dynamicTypeSize) private var typeSize
    /// one step moves on at a time: the permission prompt's return and its button can both say "done"
    @State private var flow = StepFlow<Step>([])
    @State private var asking = false
    @State private var connecting = false

    var body: some View {
        let step = flow.current ?? .ready
        // scrolls when the words are large, with the buttons always in reach at the bottom
        ScrollView {
            VStack(spacing: 0) {
                // at accessibility sizes the words need the room more than the picture does
                if !typeSize.isAccessibilitySize {
                    stage(step)
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                }
                copy(step)
                    .padding(.horizontal, 28)
                    .padding(.top, 28)
                    .padding(.bottom, 16)
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .top, spacing: 0) {
            // the bar is decoration and progress: it stops growing so the words keep the room
            topBar(step).dynamicTypeSize(...DynamicTypeSize.xxxLarge)
                .frame(minHeight: 44).padding(.horizontal, 24).background(Theme.bg)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            actions(step)
                .padding(.horizontal, 24)
                .padding(.top, 12)
                .padding(.bottom, 12)
                .background(Theme.bg)
        }
        .background(Theme.bg)
        .onAppear(perform: plan)
        .sheet(isPresented: $connecting) { ConnectSheet() }
        // back from the Settings app with access turned on: move along by itself
        .onChange(of: phase) { _, now in
            // the system prompt itself makes the app inactive and active again; its button moves on in that case
            if now == .active, !asking, let p = permission(step), p.access == .on { next(from: step) }
        }
    }

    // MARK: - Plan

    private func plan() {
        guard flow.count == 0 else { return }
        var list: [Step] = [.welcome]
        if Permission.microphone.access != .on { list.append(.microphone) }
        if Permission.speech.access != .on { list.append(.speech) }
        if model.engine.status == .notPaired { list.append(.computer) }
        list.append(.ready)
        #if DEBUG
        // screenshots: every screen, starting at -onboardingStep
        if let start = UserDefaults.standard.string(forKey: "onboardingStep").flatMap(Step.init(rawValue:)) {
            flow = StepFlow(Step.allCases, startingAt: start)
            return
        }
        #endif
        flow = StepFlow(list)
    }

    /// Moves on only if `step` is still the one showing.
    private func next(from step: Step) {
        withAnimation(.easeOut(duration: 0.28)) {
            guard flow.advance(from: step) else { return }
            if flow.finished { done() }
        }
    }

    private func permission(_ s: Step) -> Permission? {
        switch s {
        case .microphone: .microphone
        case .speech: .speech
        default: nil
        }
    }

    private var pairedName: String? {
        model.engine.status == .notPaired ? nil : model.engine.status.computerName ?? model.sync.status.computerName
    }

    // MARK: - Parts

    /// The wordmark (except on the welcome, where it sits over the title) and a quiet bar of steps.
    private func topBar(_ step: Step) -> some View {
        HStack {
            if step != .welcome { Wordmark(size: 18) }
            Spacer()
            if step != .ready { Steps(n: flow.index, total: flow.count - 1) }
        }
    }

    private func stage(_ step: Step) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 28, style: .continuous).fill(Theme.card)
            OnboardingArt(kind: art(step))
                .id(step)
                .transition(.opacity.combined(with: .scale(scale: 0.97)))
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 220, maxHeight: 320)
    }

    private func art(_ s: Step) -> OnboardingArtKind {
        switch s {
        case .welcome: .welcome
        case .microphone: .microphone
        case .speech: .speech
        case .computer: .computer
        case .ready: .ready
        }
    }

    private func copy(_ step: Step) -> some View {
        let (title, text) = words(step)
        return VStack(alignment: .leading, spacing: 10) {
            if step == .welcome { Wordmark(size: 22).padding(.bottom, 8) }
            Text(title)
                .font(Theme.brand(32, relativeTo: .largeTitle))
                .foregroundStyle(Theme.heading)
                .accessibilityAddTraits(.isHeader)
                .fixedSize(horizontal: false, vertical: true)
            Text(text)
                .font(.body)
                .foregroundStyle(Theme.written)
                .fixedSize(horizontal: false, vertical: true)
            note(step).padding(.top, 6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .id(step)
        .transition(.opacity)
    }

    private func words(_ step: Step) -> (String, String) {
        switch step {
        case .welcome: (S.welcomeTitle, S.welcomeText)
        case .microphone: (S.micTitle, S.micText)
        case .speech: (S.speechTitle, S.speechText)
        case .computer:
            if let name = pairedName { (S.allSet, S.connectedTo(name)) } else { (S.computerTitle, S.computerText) }
        case .ready: (S.readyTitle, pairedName.map(S.readyTextPaired) ?? S.readyText)
        }
    }

    @ViewBuilder private func note(_ step: Step) -> some View {
        if let p = permission(step), p.access == .restricted {
            Text(S.restricted).font(.footnote).foregroundStyle(Theme.muted)
        } else if let p = permission(step), p.access == .off {
            Text(S.turnedOffBefore).font(.footnote).foregroundStyle(Theme.muted)
        } else if step == .computer, pairedName == nil {
            // iOS asks for the local network once Yogurt starts looking; this says why before it does
            Label(S.localNetworkNote, systemImage: "wifi").font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    @ViewBuilder private func actions(_ step: Step) -> some View {
        VStack(spacing: 4) {
            switch step {
            case .welcome:
                wide(S.getStarted, id: "intro-next") { started(); next(from: step) }
            case .microphone, .speech:
                let p = permission(step)!
                if p.access == .restricted {
                    // set by someone else (Screen Time, a school or work profile): nothing to press here
                    wide(S.continueOn, id: "step-allow") { next(from: step) }
                } else if p.access == .off {
                    wide(S.openSettings, id: "step-allow") { Permission.openSettings() }
                } else {
                    wide(S.allow, id: "step-allow", busy: asking) {
                        asking = true
                        Task {
                            // yes or no, the next screen comes; a no can be changed in Settings
                            _ = await p.request()
                            asking = false
                            next(from: step)
                        }
                    }
                }
                if p.access != .restricted { later(step) }
            case .computer:
                if pairedName != nil {
                    wide(S.continueOn, id: "step-allow") { next(from: step) }
                } else {
                    wide(S.connect, id: "step-allow") { connecting = true }
                    later(step)
                }
            case .ready:
                wide(S.startUsing, id: "onboarding-done") { done() }
            }
        }
    }

    /// Onboarding shows once: from the moment it's started, a restart goes straight to Home.
    private func started() { UserDefaults.standard.set(true, forKey: "onboarded") }

    private func later(_ step: Step) -> some View {
        Button(S.notNow) { next(from: step) }
            .font(.body.weight(.medium))
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, minHeight: 44)
            .disabled(asking)
            .accessibilityIdentifier("step-later")
    }

    private func wide(_ title: String, id: String, busy: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if busy { ProgressView().tint(.white).controlSize(.small) }
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(busy)
        .accessibilityIdentifier(id)
    }
}

/// A quiet bar of segments: the ones done and this one filled, the rest waiting.
private struct Steps: View {
    let n: Int
    let total: Int
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<max(total, 1), id: \.self) { k in
                Capsule().fill(k <= n ? Theme.art : Theme.line).frame(width: 18, height: 4)
            }
        }
        .animation(.easeOut(duration: 0.25), value: n)
        .accessibilityElement()
        .accessibilityLabel(S.stepOf(n + 1, total))
    }
}

/// The app's mark and name, desktop's Wordmark.
struct Wordmark: View {
    var size: CGFloat = 20
    var body: some View {
        HStack(spacing: size * 0.4) {
            Image("Mark").resizable().frame(width: size * 1.4, height: size * 1.4)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.34, style: .continuous))
            Text("Yogurt").font(Theme.brand(size * 1.1, relativeTo: .headline)).foregroundStyle(Theme.heading)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Yogurt")
    }
}
