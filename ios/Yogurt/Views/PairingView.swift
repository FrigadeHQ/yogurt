import SwiftUI
import YogurtKit

/// First run: find the computer on this Wi-Fi, then type the 6-digit code it shows.
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @State private var chosen: DiscoveredDesktop?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let chosen {
                    CodeEntry(desktop: chosen) { withAnimation(.easeOut(duration: 0.2)) { self.chosen = nil } }
                        .transition(.opacity)
                } else {
                    finder.transition(.opacity)
                }
                Label(S.privacyNote, systemImage: "lock")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .padding(.top, 36)
                #if DEBUG
                if let preview = model.preview {
                    Button(S.trySample) { preview.loadSamples() }
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .underline()
                        .padding(.top, 20)
                        .accessibilityIdentifier("try-sample")
                }
                #endif
            }
            .padding(.horizontal, 24)
            .padding(.top, 48)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bg)
        .onAppear(perform: pickOnlyOne)
        .onChange(of: model.engine.discovered) { _, _ in pickOnlyOne() }
    }

    /// With just one computer showing a code, go straight to typing it.
    private func pickOnlyOne() {
        let ready = model.engine.discovered.filter(\.pairing)
        guard chosen == nil, ready.count == 1 else { return }
        withAnimation(.easeOut(duration: 0.2)) { chosen = ready[0] }
    }

    private var finder: some View {
        let found = model.engine.discovered
        return VStack(alignment: .leading, spacing: 0) {
            Image("Mark")
                .resizable()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                .padding(.bottom, 22)
                .accessibilityHidden(true)
            Text(S.pairTitle)
                .font(Theme.brand(32, relativeTo: .largeTitle))
                .foregroundStyle(Theme.heading)
            Text(S.pairIntro)
                .font(.body)
                .foregroundStyle(Theme.written)
                .padding(.top, 10)
            VStack(alignment: .leading, spacing: 14) {
                step(1, S.pairStep1)
                step(2, S.pairStep2)
                step(3, S.pairStep3)
            }
            .padding(.top, 26)
            // iOS asks for the local network permission on the first look around; this says why before it does
            Label(S.localNetworkNote, systemImage: "wifi")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .padding(.top, 26)
            if found.isEmpty {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text(S.pairLooking).font(.subheadline).foregroundStyle(Theme.muted)
                }
                .padding(.top, 34)
            } else {
                Text(S.pairFound)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.muted)
                    .padding(.top, 34).padding(.bottom, 8)
                VStack(spacing: 0) {
                    ForEach(found) { desktop in
                        Button {
                            withAnimation(.easeOut(duration: 0.2)) { chosen = desktop }
                        } label: { computerRow(desktop) }
                            .buttonStyle(RowButtonStyle())
                            .disabled(!desktop.pairing)
                    }
                }
                .padding(.horizontal, -8)
            }
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(n)")
                .font(.footnote.weight(.semibold).monospacedDigit())
                .foregroundStyle(Theme.accent)
                .frame(width: 24, height: 24)
                .background(Theme.accentSoft, in: Circle())
                .alignmentGuide(.firstTextBaseline) { $0[.firstTextBaseline] + 1 }
            Text(text).font(.body).foregroundStyle(Theme.ink)
        }
    }

    private func computerRow(_ d: DiscoveredDesktop) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "laptopcomputer")
                .font(.system(size: 17))
                .foregroundStyle(Theme.written)
                .frame(width: 38, height: 38)
                .background(Theme.control, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(d.name).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                Text(d.pairing ? S.pairReady : S.pairNotReady)
                    .font(.footnote)
                    .foregroundStyle(d.pairing ? Theme.live : Theme.muted)
            }
            Spacer()
            if d.pairing { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted) }
        }
        .padding(.vertical, 10).padding(.horizontal, 8)
        .opacity(d.pairing ? 1 : 0.6)
    }
}

/// Six boxes over one hidden number field: typing moves along by itself, delete goes back, and a pasted or
/// suggested code (from Messages, say) fills them all.
struct CodeEntry: View {
    let desktop: DiscoveredDesktop
    let back: () -> Void
    @Environment(AppModel.self) private var model
    @State private var code = ""
    @State private var busy = false
    @State private var failed: String?
    @State private var shake = 0
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: back) {
                Label(S.otherComputer, systemImage: "chevron.left").font(.subheadline.weight(.medium))
            }
            .foregroundStyle(Theme.accent)
            .padding(.bottom, 28)
            Text(S.codeTitle(desktop.name))
                .font(Theme.brand(30, relativeTo: .largeTitle))
                .foregroundStyle(Theme.heading)
            Text(S.codeHelp)
                .font(.body)
                .foregroundStyle(Theme.written)
                .padding(.top, 10)
            boxes
                .padding(.top, 30)
                .modifier(Shake(times: CGFloat(shake)))
            Group {
                if busy {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text(S.pairing) }
                        .foregroundStyle(Theme.muted)
                } else if let failed {
                    Text(failed).foregroundStyle(Theme.danger)
                }
            }
            .font(.subheadline)
            .frame(minHeight: 44, alignment: .topLeading)
            .padding(.top, 16)
        }
        .onAppear {
            #if DEBUG
            if let c = UserDefaults.standard.string(forKey: "pairCode") { code = c; return }
            #endif
            focused = true
        }
    }

    private var boxes: some View {
        ZStack {
            TextField("", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .focused($focused)
                .opacity(0.02)
                .accessibilityLabel(S.codeField)
                .accessibilityIdentifier("pair-code")
                .onChange(of: code) { _, new in
                    let digits = String(new.filter(\.isASCII).filter(\.isNumber).prefix(6))
                    if digits != new { code = digits; return }
                    if !digits.isEmpty { failed = nil }
                    if digits.count == 6 { submit() }
                }
            // a wider gap in the middle, so the code reads as 123 456
            HStack(spacing: 18) {
                HStack(spacing: 8) { ForEach(0..<3, id: \.self) { box($0) } }
                HStack(spacing: 8) { ForEach(3..<6, id: \.self) { box($0) } }
            }
            .allowsHitTesting(false)
        }
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
        .disabled(busy)
    }

    private func box(_ i: Int) -> some View {
        let chars = Array(code)
        let digit = i < chars.count ? String(chars[i]) : ""
        let current = focused && !busy && i == min(chars.count, 5)
        return Text(digit)
            .font(.system(size: 28, weight: .semibold, design: .rounded).monospacedDigit())
            .foregroundStyle(Theme.ink)
            .frame(maxWidth: .infinity)
            .frame(height: 60)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(failed != nil ? Theme.danger : current ? Theme.accent : Theme.line, lineWidth: current || failed != nil ? 2 : 1)
            )
            .animation(.easeOut(duration: 0.12), value: current)
    }

    private func submit() {
        guard !busy else { return }
        busy = true
        Task {
            do {
                try await model.engine.pair(with: desktop, code: code)
            } catch {
                failed = switch error as? PairingError {
                case .expired: S.pairExpired
                case .tooMany: S.pairTooMany
                case .unreachable: S.pairUnreachable
                default: S.pairFailed
                }
                code = ""
                withAnimation(.default) { shake += 1 }
                focused = true
            }
            busy = false
        }
    }
}

/// a small side-to-side shake for a wrong code
struct Shake: GeometryEffect {
    var times: CGFloat
    var animatableData: CGFloat {
        get { times }
        set { times = newValue }
    }
    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 8 * sin(times * .pi * 4), y: 0))
    }
}
