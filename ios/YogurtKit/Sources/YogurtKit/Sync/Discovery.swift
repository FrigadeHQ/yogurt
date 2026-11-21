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

    public init() {}

    public func start(_ update: @escaping @MainActor ([FoundDesktop]) -> Void) {
        stop()
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_yogurt._tcp", domain: nil), using: NWParameters())
        b.browseResultsChangedHandler = { results, _ in
            let found = Self.desktops(results)
            Task { @MainActor in update(found) }
        }
        b.stateUpdateHandler = { state in
            // a failed browser (the network went away) is started again by the engine on the next path change
            if case .failed = state { Task { @MainActor in update([]) } }
        }
        b.start(queue: .main)
        browser = b
    }

    public func stop() {
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
