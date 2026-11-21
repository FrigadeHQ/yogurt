import Foundation
import Network

/// A computer seen on the network, with where to reach it.
public struct FoundDesktop: Sendable, Hashable {
    public var desktop: DiscoveredDesktop
    public var endpoint: NWEndpoint
    public init(desktop: DiscoveredDesktop, endpoint: NWEndpoint) { self.desktop = desktop; self.endpoint = endpoint }
}

/// Finds computers running Yogurt. The real one browses Bonjour; tests hand in a fixed list.
@MainActor
public protocol DesktopBrowser: AnyObject {
    func start(_ update: @escaping @MainActor ([FoundDesktop]) -> Void)
    func stop()
}

/// Bonjour `_yogurt._tcp`, TXT v=1, id, name, pairing=0|1 (app/src/main/companion/index.ts). The first browse is
/// what makes iOS ask for the local network permission.
@MainActor
public final class BonjourBrowser: DesktopBrowser {
    private var browser: NWBrowser?
    private var restart: Task<Void, Never>?
    /// true when iOS refuses the local network, false once browsing works
    public var onDenied: (@MainActor (Bool) -> Void)?

    public init() {}

    public func start(_ update: @escaping @MainActor ([FoundDesktop]) -> Void) {
        start(update, retry: true)
    }

    private func start(_ update: @escaping @MainActor ([FoundDesktop]) -> Void, retry: Bool) {
        stop()
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_yogurt._tcp", domain: nil), using: NWParameters())
        b.browseResultsChangedHandler = { results, _ in
            let found = Self.desktops(results)
            Task { @MainActor in update(found) }
        }
        b.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .ready: self.onDenied?(false)
                case .waiting(let e) where isLocalNetworkDenied(e): self.onDenied?(true)
                case .failed(let e):
                    if isLocalNetworkDenied(e) { self.onDenied?(true) }
                    update([])
                    // mDNS restarted or the network blinked: one more try shortly, then the next path change
                    guard retry else { return }
                    self.restart = Task { [weak self] in
                        try? await Task.sleep(for: .seconds(2))
                        guard !Task.isCancelled else { return }
                        self?.start(update, retry: false)
                    }
                default: break
                }
            }
        }
        b.start(queue: .main)
        browser = b
    }

    public func stop() {
        restart?.cancel()
        browser?.cancel()
        browser = nil
    }

    nonisolated static func desktops(_ results: Set<NWBrowser.Result>) -> [FoundDesktop] {
        var seen = Set<String>()
        return results.compactMap { r -> FoundDesktop? in
            guard case .bonjour(let txt) = r.metadata, txt["v"] == "1", let id = txt["id"], !id.isEmpty else { return nil }
            // one computer can show up once per network interface
            guard seen.insert(id).inserted else { return nil }
            return FoundDesktop(desktop: DiscoveredDesktop(id: id, name: txt["name"] ?? "Computer", pairing: txt["pairing"] == "1"), endpoint: r.endpoint)
        }
        .sorted { $0.desktop.name.localizedStandardCompare($1.desktop.name) == .orderedAscending }
    }
}

/// Says when the network changed (Wi-Fi joined or switched), so a phone that lost its computer tries again at once.
@MainActor
public final class PathWatcher {
    private let monitor = NWPathMonitor()
    private var last: NWPath.Status?

    public init() {}

    public func start(_ changed: @escaping @MainActor () -> Void) {
        monitor.pathUpdateHandler = { [weak self] path in
            let status = path.status
            Task { @MainActor in
                guard let self else { return }
                if self.last != nil, status == .satisfied { changed() }
                self.last = status
            }
        }
        monitor.start(queue: .main)
    }

    deinit { monitor.cancel() }
}
