import Foundation
import Observation

/// Where the phone stands with its computer, shown at the top of Home at all times so a failed connection is never silent.
public enum ConnectionStatus: Sendable, Hashable {
    case notPaired
    /// paired, looking for the computer on this Wi-Fi
    case searching
    case connecting(String)
    /// syncing: how many meetings are still coming, nil once up to date
    case connected(String, syncing: Int?)
    case offline(String, lastSync: Date?)
    /// a sentence the person can act on, e.g. "This computer doesn't recognise this iPhone any more. Pair again."
    case error(String)

    public var label: String { label(now: Date()) }

    public func label(now: Date) -> String {
        switch self {
        // not a problem: the phone works on its own, a computer is optional
        case .notPaired: "On this iPhone only"
        case .searching: "Looking for your computer…"
        case .connecting(let name): "Connecting to \(name)…"
        case .connected(let name, nil): "Connected to \(name) · Synced just now"
        case .connected(_, let n?): n == 0 ? "Syncing…" : n == 1 ? "Syncing 1 meeting…" : "Syncing \(n) meetings…"
        case .offline(_, let last?): "Not on the same Wi-Fi · last synced \(relativeTime(last, now: now))"
        case .offline(_, nil): "Not on the same Wi-Fi · not synced yet"
        case .error(let message): message
        }
    }

    /// The paired computer's name, when the status knows it.
    public var computerName: String? {
        switch self {
        case .connecting(let name), .connected(let name, _), .offline(let name, _): name
        case .notPaired, .searching, .error: nil
        }
    }
}

/// "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago": short enough for the status pill.
public func relativeTime(_ date: Date, now: Date = Date()) -> String {
    let s = max(0, now.timeIntervalSince(date))
    switch s {
    case ..<60: return "just now"
    case ..<3600: return "\(Int(s / 60)) min ago"
    case ..<86400: return "\(Int(s / 3600)) h ago"
    case ..<(2 * 86400): return "yesterday"
    default: return "\(Int(s / 86400)) days ago"
    }
}

/// A computer running Yogurt seen on this Wi-Fi (Bonjour `_yogurt._tcp`).
public struct DiscoveredDesktop: Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// its Phone settings are open and showing a code
    public var pairing: Bool
    public init(id: String, name: String, pairing: Bool) { self.id = id; self.name = name; self.pairing = pairing }
}

/// What `ask` covers; nil asks across everything.
public struct AskScope: Sendable, Hashable, Codable {
    public var folderId: String?
    public var meetingIds: [String]?
    public init(folderId: String? = nil, meetingIds: [String]? = nil) { self.folderId = folderId; self.meetingIds = meetingIds }
}

/// The computer's answer to `ask`, with the passages it was drawn from.
public struct RemoteAnswer: Sendable, Hashable, Codable {
    public struct Source: Sendable, Hashable, Codable {
        public var meetingId: String
        public var title: String
        public var atMs: Int?
        public var text: String
        public init(meetingId: String, title: String, atMs: Int?, text: String) {
            self.meetingId = meetingId; self.title = title; self.atMs = atMs; self.text = text
        }
    }
    public var answer: String
    public var sources: [Source]
    public init(answer: String, sources: [Source]) { self.answer = answer; self.sources = sources }
}

/// What the app's screens need from sync. The real engine (Task 9) and the app's preview engine both conform, so the
/// screens don't care which one is behind them.
@MainActor
public protocol SyncEngineProtocol: AnyObject, Observable {
    var status: ConnectionStatus { get }
    /// computers seen on this Wi-Fi, for the pairing screen
    var discovered: [DiscoveredDesktop] { get }
    /// goes up each time synced data lands in the Store, so screens read it again
    var revision: Int { get }
    func pair(with desktop: DiscoveredDesktop, code: String) async throws
    func syncNow() async
    func unpair()
    func ask(_ question: String, scope: AskScope?) async throws -> RemoteAnswer
    /// the app came to the front (true) or went to the background (false)
    func setForeground(_ on: Bool)
    /// Not paired: look for computers on this Wi-Fi while the connect screen is open. Looking makes iOS ask for the
    /// local network, so it never starts on its own.
    func lookForComputers(_ on: Bool)
}

public extension SyncEngineProtocol {
    func setForeground(_ on: Bool) {}
    func lookForComputers(_ on: Bool) {}
}
