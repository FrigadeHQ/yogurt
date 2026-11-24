import SwiftUI
import YogurtKit

/// The connection, always in view at the top of Home: green when synced, a spinner while working, red on a problem.
/// Quick changes are held back (CalmStatus), so it never flickers between labels; each change crossfades.
struct StatusPill: View {
    let status: ConnectionStatus
    let action: () -> Void
    @State private var calm: CalmStatus

    init(status: ConnectionStatus, action: @escaping () -> Void = {}) {
        self.status = status
        self.action = action
        _calm = State(initialValue: CalmStatus(status, at: .now))
    }

    private var shown: ConnectionStatus { calm.shown }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                // both always there, faded in and out, so the dot's colour and the spinner change smoothly
                ZStack {
                    Circle().fill(tone).frame(width: 7, height: 7).opacity(busy ? 0 : 1)
                    ProgressView().controlSize(.mini).tint(Theme.accent).opacity(busy ? 1 : 0)
                }
                .frame(width: 8, height: 8)
                // refreshed every minute so "last synced 2 h ago" stays true
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    line(shown.label(now: context.date))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Keep brief changes from flickering between connection states.
        .animation(.easeInOut(duration: 0.35), value: shown)
        .onChange(of: status) { _, now in calm.update(now, at: .now) }
        .task(id: calm.nextCheck) {
            guard let at = calm.nextCheck else { return }
            try? await Task.sleep(for: .seconds(max(0, at.timeIntervalSinceNow)))
            guard !Task.isCancelled else { return }
            calm.settle(at: max(at, .now))
        }
        .accessibilityLabel(shown.label)
        .accessibilityHint(S.settings)
        .accessibilityIdentifier("status-pill")
    }

    private func line(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(isError ? Theme.danger : Theme.muted)
            .contentTransition(.opacity)
    }

    private var busy: Bool { shown.isBusy }

    private var isError: Bool { if case .error = shown { true } else { false } }

    private var tone: Color {
        switch shown {
        case .connected: Theme.live
        case .error: Theme.danger
        default: Theme.muted.opacity(0.7)
        }
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 12) {
        StatusPill(status: .connected("MacBook", syncing: nil))
        StatusPill(status: .connected("MacBook", syncing: 12))
        StatusPill(status: .offline("MacBook", lastSync: .now.addingTimeInterval(-7200)))
        StatusPill(status: .searching)
        StatusPill(status: .notPaired)
        StatusPill(status: .error("This computer doesn't recognise this iPhone any more. Pair again."))
    }
    .padding()
}
