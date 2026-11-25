import Foundation
import Network

/// A computer seen on the network, with every place an advert for its id said to reach it: one per network
/// interface, and maybe a fake one from someone else on the Wi-Fi, so each is tried in turn.
public struct FoundDesktop: Sendable, Hashable {
    public var desktop: DiscoveredDesktop
    public var endpoints: [NWEndpoint]
    public init(desktop: DiscoveredDesktop, endpoints: [NWEndpoint]) { self.desktop = desktop; self.endpoints = endpoints }
    public init(desktop: DiscoveredDesktop, endpoint: NWEndpoint) { self.init(desktop: desktop, endpoints: [endpoint]) }
}

/// Tries `attempt` on each endpoint in turn and returns the first that works. A `soft` failure (a refused key, a
/// wrong code) is thrown only when every endpoint failed that way, so a fake advert for the same id can't make the
/// real computer look like it refused. A denied local network stops at once: every endpoint would say the same.
func eachEndpoint<E: Sendable, T>(_ endpoints: [E], isolation: isolated (any Actor)? = #isolation, soft: (Error) -> Bool,
                        _ attempt: (E) async throws -> T) async throws -> T {
    var errors: [Error] = []
    for e in endpoints {
        do { return try await attempt(e) } catch {
            if error as? SyncError == .localNetworkDenied || error is CancellationError { throw error }
            errors.append(error)
        }
    }
    throw errors.first { !soft($0) } ?? errors.first ?? SyncError.closed
}

/// Finds computers running Yogurt. The real one browses Bonjour; tests hand in a fixed list.
@MainActor
public protocol DesktopBrowser: AnyObject {
    func start(_ update: @escaping @MainActor ([FoundDesktop]) -> Void)
    func stop()
}

/// Bonjour `_yogurt._tcp`, TXT v=1, id, pairing=0|1 (app/src/main/companion/index.ts). No name: anyone on the Wi-Fi
/// can read an advert, so the computer's name comes sealed in pairing, then in hello. The first browse is
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
            let found = Self.desktops(results.compactMap { r in
                if case .bonjour(let txt) = r.metadata { (txt.dictionary, r.endpoint) } else { nil }
            })
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

    /// One entry per computer id, with every endpoint its adverts gave, in the order they came. The name stays empty
    /// until pairing tells it (the screens show a plain label meanwhile).
    nonisolated static func desktops(_ adverts: [(txt: [String: String], endpoint: NWEndpoint)]) -> [FoundDesktop] {
        var out: [FoundDesktop] = []
        for (txt, endpoint) in adverts {
            guard txt["v"] == "1", let id = txt["id"], !id.isEmpty else { continue }
            let pairing = txt["pairing"] == "1"
            if let i = out.firstIndex(where: { $0.desktop.id == id }) {
                if !out[i].endpoints.contains(endpoint) { out[i].endpoints.append(endpoint) }
                out[i].desktop.pairing = out[i].desktop.pairing || pairing
            } else {
                out.append(FoundDesktop(desktop: DiscoveredDesktop(id: id, name: "", pairing: pairing), endpoint: endpoint))
            }
        }
        return out.sorted { $0.desktop.id < $1.desktop.id }
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
