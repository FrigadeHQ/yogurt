#if DEBUG
import Foundation
import YogurtKit

/// DEBUG only: "Try with sample meetings" and screenshots. Never touches the network. With sample meetings loaded it acts
/// like a connected computer, taking queued edits as the desktop would, so every screen can be tried for real.
@MainActor @Observable
final class PreviewSyncEngine: SyncEngineProtocol {
    private(set) var status: ConnectionStatus
    private(set) var discovered: [DiscoveredDesktop]
    private(set) var revision = 0
    @ObservationIgnored private let store: Store

    static let sampleKey = "previewSampleMeetings"
    static let computerName = "MacBook"
    /// a pretend computer for checking the pairing screen (DEBUG launch argument -previewComputer YES)
    static let demoComputer = DiscoveredDesktop(id: "preview", name: computerName, pairing: true)

    var showingSamples: Bool { UserDefaults.standard.bool(forKey: Self.sampleKey) }

    init(store: Store, discovered: [DiscoveredDesktop] = []) {
        self.store = store
        self.discovered = discovered
        status = UserDefaults.standard.bool(forKey: Self.sampleKey) ? .connected(Self.computerName, syncing: nil) : .notPaired
    }

    func loadSamples() {
        try? store.apply(SampleData.changes(), cursor: 1)
        UserDefaults.standard.set(true, forKey: Self.sampleKey)
        status = .connected(Self.computerName, syncing: nil)
        revision += 1
    }

    /// For screenshots of the pill (DEBUG launch argument -previewStatus).
    func show(_ status: ConnectionStatus) { self.status = status }
    func showDiscovered(_ desktops: [DiscoveredDesktop]) { discovered = desktops }

    func pair(with desktop: DiscoveredDesktop, code: String) async throws {
        try await Task.sleep(for: .milliseconds(700))
        guard desktop.id == Self.demoComputer.id, code == "123456" else { throw PreviewError.wrongCode }
        loadSamples()
    }

    func syncNow() async {
        guard showingSamples else { return }
        let ops = store.pendingOps()
        status = .connected(Self.computerName, syncing: max(ops.count, 1))
        try? await Task.sleep(for: .milliseconds(ops.isEmpty ? 900 : 250))
        for pending in ops { takeAsDesktop(pending) }
        status = .connected(Self.computerName, syncing: nil)
        revision += 1
    }

    func unpair() {
        try? store.resetForNewEpoch()
        UserDefaults.standard.set(false, forKey: Self.sampleKey)
        status = .notPaired
        revision += 1
    }

    func ask(_ question: String, scope: AskScope?) async throws -> RemoteAnswer {
        try await Task.sleep(for: .milliseconds(600))
        let first = store.meetings().first
        return RemoteAnswer(answer: "These are sample meetings, so this is a sample answer.",
                            sources: first.map { [.init(meetingId: $0.id, title: $0.title, atMs: nil, text: "")] } ?? [])
    }

    /// Applies an edit the way the desktop would, then sends the records back as a pull would.
    private func takeAsDesktop(_ pending: PendingOp) {
        let op = pending.op
        guard var m = store.meeting(op.meetingId) else { try? store.markSent(pending.id); return }
        var records: [[String: Any]] = []
        switch op.kind {
        case .setMine:
            let text = op.text ?? ""
            let summary: Any = store.notes(m.id)?.summary ?? NSNull()
            records.append(["entity": "notes", "id": m.id, "record": [
                "meetingId": m.id, "mine": text, "summary": summary, "mineHash": notesHash(text),
            ] as [String: Any]])
        case .rename:
            m.title = op.title ?? m.title
            records.append(meetingRecord(m))
        case .trash, .restore:
            m.trashedAt = op.kind == .trash ? Date() : nil
            records.append(meetingRecord(m))
        case .addToFolder, .removeFromFolder:
            guard let folder = op.folderId else { break }
            var ids = store.meetings(folder: folder).map(\.id).filter { $0 != m.id }
            if op.kind == .addToFolder { ids.insert(m.id, at: 0) }
            records.append(["entity": "folderMembers", "id": folder, "record": ["folderId": folder, "meetingIds": ids]])
        }
        if let data = try? JSONSerialization.data(withJSONObject: records),
           let changes = try? JSONDecoder().decode([Change].self, from: data) {
            try? store.apply(changes, cursor: store.cursor + 1)
        }
        try? store.markSent(pending.id)
    }

    private func meetingRecord(_ m: Meeting) -> [String: Any] {
        let attendees: [[String: Any]] = m.attendees.map { a in
            ["name": a.name as Any? ?? NSNull(), "email": a.email as Any? ?? NSNull()]
        }
        var record: [String: Any] = ["id": m.id, "title": m.title, "startedAt": ms(m.startedAt), "attendees": attendees]
        record["endedAt"] = m.endedAt.map(ms) ?? NSNull()
        record["app"] = m.app ?? NSNull()
        record["trashedAt"] = m.trashedAt.map(ms) ?? NSNull()
        record["language"] = m.language ?? NSNull()
        return ["entity": "meeting", "id": m.id, "record": record]
    }

    enum PreviewError: Error { case wrongCode }
}

private func ms(_ d: Date) -> Double { (d.timeIntervalSince1970 * 1000).rounded() }
#endif
