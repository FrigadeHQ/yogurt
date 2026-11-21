import SwiftUI

/*
 * The first run's pictures, drawn from the app's own surfaces like desktop's OnboardingArt.tsx: soft cards in both
 * themes and one purple. Each shows what its screen does. They are hidden from VoiceOver: the words beside them say
 * the same thing. Motion stops under Reduce Motion, showing the end of each story.
 */

enum OnboardingArtKind { case welcome, microphone, speech, computer, ready }

struct OnboardingArt: View {
    let kind: OnboardingArtKind

    var body: some View {
        Group {
            switch kind {
            case .welcome: WelcomeArt()
            case .microphone: MicArt()
            case .speech: SpeechArt()
            case .computer: ComputerArt()
            case .ready: ReadyArt()
            }
        }
        .accessibilityHidden(true)
    }
}

/// A soft floating card, desktop's `.ob-card`.
private struct ArtCard: ViewModifier {
    var radius: CGFloat = 18
    func body(content: Content) -> some View {
        content
            // the shadow sits on the card's shape only, so the words inside stay crisp
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.float)
                    .shadow(color: .black.opacity(0.07), radius: 18, y: 10)
            }
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.line))
    }
}

private extension View {
    func artCard(radius: CGFloat = 18) -> some View { modifier(ArtCard(radius: radius)) }
}

/// A grey bar standing in for text.
private struct Skeleton: View {
    var width: CGFloat
    var body: some View { Capsule().fill(Theme.line).frame(width: width, height: 7) }
}

/// A small chip with an icon, like the "On this iPhone" badge.
private struct ArtChip: View {
    let symbol: String
    let text: String
    var body: some View {
        Label(text, systemImage: symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.art)
            .padding(.horizontal, 10).frame(height: 28)
            .background(Theme.artSoft, in: Capsule())
    }
}

/// The recording pill: a beating dot and the time.
private struct RecordingDot: View {
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var on = false
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Theme.art).frame(width: 7, height: 7)
                .opacity(on ? 0.35 : 1)
            Text("0:24").font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.ink)
        }
        .padding(.horizontal, 10).frame(height: 26)
        .background(Theme.card, in: Capsule())
        .onAppear {
            guard !still else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { on = true }
        }
    }
}

/// The meeting written down: a note with its summary, and that it stays on the phone.
private struct WelcomeArt: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(S.artMeeting).font(.headline).foregroundStyle(Theme.heading)
                    Text(S.artWhen).font(.caption).foregroundStyle(Theme.muted)
                }
                Spacer()
                RecordingDot()
            }
            Text(S.summary.uppercased())
                .font(.caption2.weight(.semibold)).tracking(0.6)
                .foregroundStyle(Theme.muted)
                .padding(.top, 16).padding(.bottom, 8)
            VStack(alignment: .leading, spacing: 8) {
                bullet(S.artPoint1)
                bullet(S.artPoint2)
                HStack(spacing: 8) { dot; Skeleton(width: 120) }
            }
        }
        .padding(18)
        .padding(.bottom, 10)
        .frame(width: 270)
        .artCard()
        .overlay(alignment: .bottomLeading) {
            ArtChip(symbol: "iphone", text: S.artOnPhone).offset(x: -14, y: 14)
        }
    }

    private var dot: some View { Circle().fill(Theme.art).frame(width: 5, height: 5) }

    private func bullet(_ text: String) -> some View {
        HStack(spacing: 8) { dot; Text(text).font(.subheadline).foregroundStyle(Theme.written).lineLimit(1) }
    }
}

/// The sound coming in: one lane like desktop's recorder, its five bars moving.
private struct MicArt: View {
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var t = false
    private let peaks: [CGFloat] = [0.54, 0.8, 1, 0.72, 0.42]

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "mic.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.art)
                    .frame(width: 38, height: 38)
                    .background(Theme.artSoft, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(S.artYou).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
                    Text(S.micTitle).font(.caption).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 8)
                HStack(spacing: 4) {
                    ForEach(peaks.indices, id: \.self) { i in
                        Capsule().fill(Theme.art)
                            .frame(width: 4, height: 30 * (t ? peaks[i] : peaks[(i + 2) % peaks.count] * 0.5))
                            .animation(still ? nil : .easeInOut(duration: 0.42 + Double(i) * 0.06).repeatForever(autoreverses: true), value: t)
                    }
                }
                .frame(height: 30)
                .layoutPriority(-1)
            }
            .padding(14)
            .artCard(radius: 16)
            HStack(spacing: 12) {
                Image(systemName: "waveform")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 38, height: 38)
                    .background(Theme.control, in: Circle())
                VStack(alignment: .leading, spacing: 6) { Skeleton(width: 90); Skeleton(width: 60) }
                Spacer()
            }
            .padding(14)
            .artCard(radius: 16)
            .opacity(0.6)
            .scaleEffect(0.94)
        }
        .frame(width: 290)
        // under Reduce Motion the bars stand still at their peaks
        .onAppear { t = true }
    }
}

/// The words written down as they're said, on the phone.
private struct SpeechArt: View {
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var caret = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            turn(S.me, "0:12", S.artLine1, me: true)
            turn(S.them, "0:18", S.artLine2, me: false)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(S.me).font(.caption.weight(.semibold)).foregroundStyle(Theme.art)
                    Text("0:25").font(.caption2.monospacedDigit()).foregroundStyle(Theme.muted)
                }
                HStack(spacing: 4) {
                    Skeleton(width: 110)
                    RoundedRectangle(cornerRadius: 1).fill(Theme.art).frame(width: 2, height: 14).opacity(caret ? 0 : 1)
                }
            }
        }
        .padding(18)
        .frame(width: 270, alignment: .leading)
        .artCard()
        .overlay(alignment: .topTrailing) {
            ArtChip(symbol: "lock.fill", text: S.artWritten).offset(x: 12, y: -14)
        }
        .onAppear {
            guard !still else { return }
            withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) { caret = true }
        }
    }

    private func turn(_ who: String, _ at: String, _ text: String, me: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(who).font(.caption.weight(.semibold)).foregroundStyle(me ? Theme.art : Theme.ink)
                Text(at).font(.caption2.monospacedDigit()).foregroundStyle(Theme.muted)
            }
            Text(text).font(.subheadline).foregroundStyle(Theme.written).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The computer and the phone side by side on the same Wi-Fi.
private struct ComputerArt: View {
    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            laptop
            link.padding(.bottom, 40)
            phone
        }
    }

    private var laptop: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 4) { ForEach(0..<3, id: \.self) { _ in Circle().fill(Theme.line).frame(width: 5, height: 5) } }
                    .padding(.bottom, 3)
                row(64); row(48); row(56)
            }
            .padding(12)
            .frame(width: 150, height: 100, alignment: .topLeading)
            .artCard(radius: 12)
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(Theme.control)
                .frame(width: 176, height: 9)
                .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(Theme.line))
        }
    }

    private var phone: some View {
        VStack(alignment: .leading, spacing: 7) {
            Capsule().fill(Theme.line).frame(width: 24, height: 5).frame(maxWidth: .infinity).padding(.bottom, 4)
            row(30); row(40); row(24)
        }
        .padding(10)
        .frame(width: 66, height: 122, alignment: .top)
        .artCard(radius: 14)
    }

    private var link: some View {
        ZStack {
            Line().stroke(Theme.art.opacity(0.5), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [2, 6]))
                .frame(width: 64, height: 2)
            Image(systemName: "wifi")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(Theme.art)
                .frame(width: 34, height: 34)
                .background(Theme.artSoft, in: Circle())
                .overlay(Circle().strokeBorder(Theme.float, lineWidth: 3))
        }
        .frame(width: 64)
    }

    /// a meeting row: a small tile and a line of text
    private func row(_ w: CGFloat) -> some View {
        HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 3).fill(Theme.artSoft).frame(width: 10, height: 10)
            Skeleton(width: w)
        }
    }

    private struct Line: Shape {
        func path(in r: CGRect) -> Path { Path { p in p.move(to: CGPoint(x: r.minX, y: r.midY)); p.addLine(to: CGPoint(x: r.maxX, y: r.midY)) } }
    }
}

/// Home, ready: a couple of meetings and the Record button.
private struct ReadyArt: View {
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(S.yourMeetings).font(Theme.brand(17)).foregroundStyle(Theme.heading).padding(.bottom, 8)
                meeting(S.artMeeting, S.artWhen, initials: "MA")
                meeting(S.artMeeting2, S.artWhen2, initials: nil)
            }
            .padding(16)
            .padding(.bottom, 14)
            .frame(width: 270, alignment: .leading)
            .artCard()
            Label(S.record, systemImage: "mic.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 18).frame(height: 40)
                // the app's own Record button: brand purple in both themes, so white reads on it
                .background(Theme.primary, in: Capsule())
                .shadow(color: Theme.primary.opacity(0.3), radius: 12, y: 6)
                .offset(y: -20)
        }
    }

    private func meeting(_ title: String, _ when: String, initials: String?) -> some View {
        HStack(spacing: 10) {
            Group {
                if let initials { Text(initials).font(.caption2.weight(.semibold)) } else { Image(systemName: "person.2").font(.caption) }
            }
            .foregroundStyle(Theme.written)
            .frame(width: 32, height: 32)
            .background(Theme.control, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                Text(when).font(.caption).foregroundStyle(Theme.muted)
            }
        }
        .padding(.vertical, 5)
    }
}
