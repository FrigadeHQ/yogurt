import Foundation

/// What Home's pill shows, kept calm when the connection changes quickly: a sync that's over within a moment never
/// shows, a shown status stays at least a second, and the latest status is always shown in the end. Problems show at
/// once. Times are passed in, so the pill's clock is the caller's.
public struct CalmStatus: Sendable {
    /// a busy status (looking, connecting, syncing) shows only once it has lasted this long
    public static let busyDelay: TimeInterval = 0.6
    /// a shown status stays at least this long before the next one replaces it
    public static let minimumShown: TimeInterval = 1

    public private(set) var shown: ConnectionStatus
    private var shownSince: Date
    private var latest: ConnectionStatus
    /// when the latest run of busy statuses began
    private var busySince: Date?

    public init(_ status: ConnectionStatus, at now: Date) {
        shown = status
        shownSince = now
        latest = status
        busySince = status.isBusy ? now : nil
    }

    /// The status changed.
    public mutating func update(_ status: ConnectionStatus, at now: Date) {
        guard status != latest else { return }
        if status.isBusy && !latest.isBusy { busySince = now }
        if !status.isBusy { busySince = nil }
        latest = status
        // a problem is something to act on, so it never waits
        if case .error = status { show(status, at: now); return }
        settle(at: now)
    }

    /// Shows the latest status if it may show by now; call again at `nextCheck`.
    public mutating func settle(at now: Date) {
        guard let due = due, now >= due else { return }
        show(latest, at: now)
    }

    /// When `settle` should run next, or nil when the latest status is already shown.
    public var nextCheck: Date? { due }

    private var due: Date? {
        guard latest != shown else { return nil }
        var at = shownSince.addingTimeInterval(Self.minimumShown)
        if latest.isBusy, let busySince { at = max(at, busySince.addingTimeInterval(Self.busyDelay)) }
        return at
    }

    private mutating func show(_ status: ConnectionStatus, at now: Date) {
        shown = status
        shownSince = now
    }
}

extension ConnectionStatus {
    /// working on it: the pill shows a spinner
    public var isBusy: Bool {
        switch self {
        case .searching, .connecting, .connected(_, syncing: _?): true
        default: false
        }
    }
}
