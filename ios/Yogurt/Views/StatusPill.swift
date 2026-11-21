import SwiftUI
import YogurtKit

/// The connection, always in view at the top of Home: green when synced, a spinner while working, red on a problem.
struct StatusPill: View {
    let status: ConnectionStatus
    var action: () -> Void = {}

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if busy {
                    ProgressView().controlSize(.mini).tint(Theme.accent).frame(width: 8, height: 8)
                } else {
                    Circle().fill(tone).frame(width: 7, height: 7)
                }
                // refreshed every minute so "last synced 2 h ago" stays true
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(status.label(now: context.date))
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(isError ? Theme.danger : Theme.ink)
                        // a problem gets two lines, so the person can read what to do
                        .lineLimit(isError ? 2 : 1)
                        .minimumScaleFactor(0.85)
                        .contentTransition(.opacity)
                }
            }
            .padding(.leading, 11).padding(.trailing, 13)
            .padding(.vertical, isError ? 6 : 0)
            .frame(minHeight: 32)
            .background(isError ? Theme.dangerSoft : Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.line.opacity(isError ? 0 : 1), lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.18), value: status)
        .accessibilityLabel(status.label)
        .accessibilityHint(S.settings)
        .accessibilityIdentifier("status-pill")
    }

    private var busy: Bool {
        switch status {
        case .searching, .connecting, .connected(_, syncing: _?): true
        default: false
        }
    }

    private var isError: Bool { if case .error = status { true } else { false } }

    private var tone: Color {
        switch status {
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
