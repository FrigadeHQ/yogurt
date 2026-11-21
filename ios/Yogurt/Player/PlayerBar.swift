import SwiftUI
import YogurtKit

/// A compact player at the foot of the Note: play or pause, the time, a scrubber and the speed (1×, 1.5×, 2×).
/// With no audio to play it is one quiet line instead.
struct PlayerBar: View {
    let player: NotePlayer
    let retry: () -> Void

    var body: some View {
        Group {
            switch player.state {
            case .loading: EmptyView()
            case .nearby: quiet(S.audioNearby)
            case .noAudio: quiet(S.audioNone)
            case .downloading(let p): downloading(p)
            case .failed(let message): failed(message)
            case .ready: controls
            }
        }
        .padding(.horizontal, 16).padding(.bottom, 8)
        .animation(.easeOut(duration: 0.2), value: player.state)
    }

    private func quiet(_ text: String) -> some View {
        Label(text, systemImage: "waveform.slash")
            .font(.footnote)
            .foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity)
            .padding(.top, 8)
            .accessibilityIdentifier("player-quiet")
    }

    private func downloading(_ p: Double) -> some View {
        HStack(spacing: 12) {
            ProgressView(value: p).tint(Theme.primary)
            Text(S.audioDownloading).font(.footnote).foregroundStyle(Theme.muted).fixedSize()
        }
        .padding(14)
        .card()
        .accessibilityIdentifier("player-downloading")
    }

    private func failed(_ message: String) -> some View {
        HStack(spacing: 12) {
            Text(message).font(.footnote).foregroundStyle(Theme.muted)
            Spacer(minLength: 0)
            if message == S.audioNotLoaded { Button(S.tryAgain, action: retry).font(.footnote.weight(.semibold)) }
        }
        .padding(14)
        .card()
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Button { player.toggle() } label: {
                Image(systemName: player.playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Theme.primary, in: Circle())
            }
            .disabled(player.blocked)
            .opacity(player.blocked ? 0.4 : 1)
            .accessibilityLabel(player.playing ? S.pause : S.play)
            .accessibilityIdentifier("player-toggle")

            Text(PlayerLogic.clock(ms: player.positionMs))
                .font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                .frame(minWidth: 34, alignment: .trailing)

            Slider(
                value: Binding(get: { PlayerLogic.fraction(ms: player.positionMs, duration: player.durationMs) },
                               set: { player.seek(to: PlayerLogic.ms(atFraction: $0, duration: player.durationMs)) }),
                in: 0...1, onEditingChanged: { player.scrubbing = $0 }
            )
            .tint(Theme.primary)
            .accessibilityLabel(S.position)
            .accessibilityValue(PlayerLogic.clock(ms: player.positionMs))

            Text(PlayerLogic.clock(ms: player.durationMs))
                .font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                .frame(minWidth: 34, alignment: .leading)

            Button { player.cycleRate() } label: {
                Text(PlayerLogic.rateLabel(player.rate))
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Theme.ink)
                    .frame(minWidth: 38, minHeight: 28)
                    .background(Theme.control, in: Capsule())
            }
            .accessibilityLabel(S.playbackSpeed)
            .accessibilityValue(PlayerLogic.rateLabel(player.rate))
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .card()
        .accessibilityIdentifier("player-bar")
    }
}

private extension View {
    func card() -> some View {
        background(Theme.float, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.line))
            .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
    }
}
