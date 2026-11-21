import Foundation
import os
import SQLite3

/// The phone's copy of the desktop's meetings, plus what only the phone has: edits not yet sent and meetings recorded
/// here. Filled from `pull` pages; nothing in it is the source of truth except pending ops and local recordings.
///
/// Concurrency: not Sendable and not thread-safe. Create it on one actor and use it only there (the app keeps it on
/// the main actor, beside the SyncEngine). Every write is one SQLite transaction, so a crash leaves a whole page or none.
public final class Store {
    let db: Database
    /// Ids and counts only, never note text. Tests replace it.
    var log: (String) -> Void = { Logger(subsystem: "chat.yogurt", category: "store").notice("\($0, privacy: .public)") }

    public init(url: URL) throws {
        db = try Database(url: url)
        try migrate()
    }

    private func migrate() throws {
        // no stored data to carry over before 1.0: version 0 is a new file
        let version = try db.query("PRAGMA user_version").first?.first?.int ?? 0
        // a file from a newer build (the app went back a version): reading it as this one could lose data
        guard version <= 1 else { throw DatabaseError(code: SQLITE_CANTOPEN, message: "store version \(version) is newer than this app") }
        guard version == 0 else { return }
        try db.transaction {
            for sql in [
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                // source: 'desktop' once the desktop sent it, 'phone' for a recording only the phone has so far
                """
                CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
                  attendees TEXT NOT NULL, app TEXT, trashed_at INTEGER, language TEXT, source TEXT NOT NULL)
                """,
                // mine_hash: the desktop's hash of My notes as last received, the base of the next setMine
                "CREATE TABLE notes (meeting_id TEXT PRIMARY KEY, mine TEXT NOT NULL, summary TEXT, mine_hash TEXT NOT NULL, summary_source TEXT NOT NULL)",
                "CREATE TABLE segments (meeting_id TEXT NOT NULL, idx INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, speaker TEXT, text TEXT NOT NULL, PRIMARY KEY (meeting_id, idx))",
                "CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)",
                "CREATE TABLE folder_members (folder_id TEXT NOT NULL, meeting_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (folder_id, meeting_id))",
                "CREATE INDEX folder_members_meeting ON folder_members (meeting_id)",
                "CREATE TABLE people (email TEXT PRIMARY KEY, display_name TEXT)",
                "CREATE TABLE pending_ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, created_at REAL NOT NULL, kind TEXT NOT NULL, meeting_id TEXT NOT NULL, folder_id TEXT, text TEXT, title TEXT, base_hash TEXT)",
                // a setMine merged into a newer one keeps its old id and text here, in case it was already on its way
                "CREATE TABLE op_aliases (old_id TEXT PRIMARY KEY, live_id TEXT NOT NULL, text TEXT NOT NULL)",
                "CREATE TABLE local_recordings (id TEXT PRIMARY KEY, started_at REAL NOT NULL, data TEXT NOT NULL)",
                "CREATE VIRTUAL TABLE search USING fts5 (meeting_id UNINDEXED, title, mine, summary, transcript, tokenize = 'unicode61 remove_diacritics 2')",
                "PRAGMA user_version = 1",
            ] { try db.run(sql) }
        }
    }

    // MARK: - Sync state

    /// The `since` for the next pull.
    public var cursor: Int { meta("cursor").flatMap { Int($0) } ?? 0 }

    /// The desktop log these changes came from. When a pull returns another one, call resetForNewEpoch().
    public var epoch: String? { meta("epoch") }

    /// Applies one pull page, and keeps its cursor (and epoch, when given) with it.
    public func apply(_ changes: [Change], cursor: Int, epoch: String? = nil) throws {
        try db.transaction {
            var touched = Set<String>()
            for change in changes { try apply(change, touched: &touched) }
            try reindex(touched)
            try setMeta("cursor", String(cursor))
            if let epoch { try setMeta("epoch", epoch) }
        }
    }

    /// The desktop's database was replaced: drop everything that came from it, and the cursor, so the next pull starts
    /// from 0. Edits not yet sent and meetings recorded here stay.
    public func resetForNewEpoch() throws {
        try db.transaction {
            for table in ["meetings", "notes", "segments", "folders", "folder_members", "people", "search"] {
                try db.run("DELETE FROM \(table)")
            }
            try db.run("DELETE FROM meta WHERE key IN ('cursor', 'epoch')")
            for rec in try loadRecordings() { try writeDraft(rec) }
        }
    }

    /// Unpaired: everything from the desktop goes, and so do edits meant for it. Meetings recorded here stay (they may
    /// exist nowhere else), as drafts again.
    public func forgetDesktop() throws {
        try db.transaction {
            try db.run("DELETE FROM pending_ops")
            try db.run("DELETE FROM op_aliases")
            try resetForNewEpoch()
        }
    }

    private func apply(_ change: Change, touched: inout Set<String>) throws {
        let id = change.id
        if change.undecodable {
            // skip just this one, so one odd record can't stall sync at the same cursor forever
            log("skipped an undecodable \(change.entity) change, id \(id)")
            return
        }
        switch change.record {
        case .meeting(let r):
            try db.run("""
                INSERT INTO meetings (id, title, started_at, ended_at, attendees, app, trashed_at, language, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'desktop')
                ON CONFLICT (id) DO UPDATE SET title = excluded.title, started_at = excluded.started_at, ended_at = excluded.ended_at,
                  attendees = excluded.attendees, app = excluded.app, trashed_at = excluded.trashed_at, language = excluded.language, source = 'desktop'
                """, [.text(id), .text(r.title ?? ""), .int(ms(r.startedAt)), .of(r.endedAt.map(ms)), .text(json(r.attendees ?? [])),
                      .of(r.app), .of(r.trashedAt.map(ms)), .of(r.language)])
            // a rename or trash made here and not yet answered is newer than this record
            try applyPendingMeetingEdits(id)
            touched.insert(id)
        case .notes(let r):
            let existing = try db.query("SELECT summary, summary_source, mine, mine_hash FROM notes WHERE meeting_id = ?", [.text(id)]).first
            // a phone draft's summary stays until the desktop has written its own
            let keepDraft = existing?[1].string == Notes.SummarySource.phoneDraft.rawValue && r.summary == nil
            let summary: SQLValue = keepDraft ? existing![0] : .of(r.summary)
            let source = keepDraft ? Notes.SummarySource.phoneDraft : .desktop
            // an edit made here and not yet sent is newer than anything the desktop can have
            // a record without My notes says nothing about them: what is here stays, with its hash
            let mine = try pendingMine(id) ?? r.mine ?? existing?[2].string ?? ""
            let hash = r.mineHash ?? r.mine.map(notesHash) ?? existing?[3].string ?? notesHash("")
            try db.run("INSERT OR REPLACE INTO notes (meeting_id, mine, summary, mine_hash, summary_source) VALUES (?, ?, ?, ?, ?)",
                       [.text(id), .text(mine), summary, .text(hash), .text(source.rawValue)])
            touched.insert(id)
        case .segments(let r):
            // the desktop sends an empty transcript while it is still transcribing a phone recording: keep the draft
            if r.segments.isEmpty, try !db.query("SELECT 1 FROM local_recordings WHERE id = ?", [.text(id)]).isEmpty { break }
            try writeSegments(id, r.segments.map { (Int(ms($0.startMs)), Int(ms($0.endMs)), $0.speaker, $0.text) })
            touched.insert(id)
        case .folder(let r):
            try db.run("INSERT OR REPLACE INTO folders (id, name, created_at) VALUES (?, ?, ?)", [.text(id), .text(r.name), .int(ms(r.createdAt))])
        case .folderMembers(let r):
            try db.run("DELETE FROM folder_members WHERE folder_id = ?", [.text(id)])
            for (i, m) in r.meetingIds.enumerated() {
                try db.run("INSERT OR IGNORE INTO folder_members (folder_id, meeting_id, position) VALUES (?, ?, ?)", [.text(id), .text(m), .of(i)])
            }
        case .people(let r):
            try db.run("INSERT OR REPLACE INTO people (email, display_name) VALUES (?, ?)", [.text(id), .of(r.displayName)])
        case nil:
            guard change.deleted else { return }
            switch change.entity {
            case "meeting":
                for sql in ["DELETE FROM meetings WHERE id = ?", "DELETE FROM notes WHERE meeting_id = ?",
                            "DELETE FROM segments WHERE meeting_id = ?", "DELETE FROM folder_members WHERE meeting_id = ?"] {
                    try db.run(sql, [.text(id)])
                }
                touched.insert(id)
            case "notes":
                try db.run("DELETE FROM notes WHERE meeting_id = ?", [.text(id)])
                touched.insert(id)
            case "segments":
                try db.run("DELETE FROM segments WHERE meeting_id = ?", [.text(id)])
                touched.insert(id)
            case "folder":
                try db.run("DELETE FROM folders WHERE id = ?", [.text(id)])
                try db.run("DELETE FROM folder_members WHERE folder_id = ?", [.text(id)])
            case "folderMembers":
                try db.run("DELETE FROM folder_members WHERE folder_id = ?", [.text(id)])
            case "people":
                try db.run("DELETE FROM people WHERE email = ?", [.text(id)])
            default:
                break
            }
        }
    }

    // MARK: - Reading

    /// Newest first. Trashed meetings only when `trashed` is true.
    public func meetings(folder: String? = nil, trashed: Bool = false) -> [Meeting] {
        let join = folder == nil ? "" : "JOIN folder_members f ON f.meeting_id = m.id AND f.folder_id = ?"
        let rows = (try? db.query("""
            SELECT m.id, m.title, m.started_at, m.ended_at, m.attendees, m.app, m.trashed_at, m.language FROM meetings m \(join)
            WHERE m.trashed_at IS \(trashed ? "NOT NULL" : "NULL") ORDER BY m.started_at DESC, m.id
            """, folder.map { [.text($0)] } ?? [])) ?? []
        return rows.map(meeting(row:))
    }

    public func meeting(_ id: String) -> Meeting? {
        (try? db.query("SELECT id, title, started_at, ended_at, attendees, app, trashed_at, language FROM meetings WHERE id = ?", [.text(id)]))?
            .first.map(meeting(row:))
    }

    public func notes(_ meetingId: String) -> Notes? {
        guard let r = (try? db.query("SELECT mine, summary, summary_source FROM notes WHERE meeting_id = ?", [.text(meetingId)]))?.first
        else { return nil }
        return Notes(meetingId: meetingId, mine: r[0].string ?? "", summary: r[1].string,
                     summarySource: Notes.SummarySource(rawValue: r[2].string ?? "") ?? .desktop)
    }

    public func segments(_ meetingId: String) -> [Segment] {
        ((try? db.query("SELECT idx, start_ms, end_ms, speaker, text FROM segments WHERE meeting_id = ? ORDER BY idx", [.text(meetingId)])) ?? [])
            .map { Segment(index: Int($0[0].int ?? 0), startMs: Int($0[1].int ?? 0), endMs: Int($0[2].int ?? 0), speaker: $0[3].string, text: $0[4].string ?? "") }
    }

    public func folders() -> [Folder] {
        ((try? db.query("SELECT id, name, created_at FROM folders ORDER BY name COLLATE NOCASE, id")) ?? [])
            .map { Folder(id: $0[0].string ?? "", name: $0[1].string ?? "", createdAt: date($0[2].int ?? 0)) }
    }

    public func people() -> [Person] {
        ((try? db.query("SELECT email, display_name FROM people ORDER BY email")) ?? [])
            .map { Person(email: $0[0].string ?? "", displayName: $0[1].string) }
    }

    private func meeting(row r: [SQLValue]) -> Meeting {
        Meeting(id: r[0].string ?? "", title: r[1].string ?? "", startedAt: date(r[2].int ?? 0), endedAt: r[3].int.map(date),
                attendees: (try? JSONDecoder().decode([Attendee].self, from: Data((r[4].string ?? "[]").utf8))) ?? [],
                app: r[5].string, trashedAt: r[6].int.map(date), language: r[7].string)
    }

    // MARK: - Edits made here

    /// My notes typed on the phone: shown at once, and queued for the desktop.
    public func editMine(meetingId: String, text: String) throws {
        try enqueue(PendingOp(Op(kind: .setMine, meetingId: meetingId, text: text)))
    }

    /// Queues an edit for the desktop. A setMine right after another setMine for the same meeting (no other edit to
    /// that meeting between) merges into it: the newest text, the oldest base hash, as one edit made from that base.
    public func enqueue(_ pending: PendingOp) throws {
        try db.transaction {
            var op = pending.op
            if op.kind == .setMine {
                if op.baseHash?.isEmpty ?? true {
                    op.baseHash = try db.query("SELECT mine_hash FROM notes WHERE meeting_id = ?", [.text(op.meetingId)]).first?[0].string
                }
                let text = op.text ?? ""
                try db.run("UPDATE notes SET mine = ? WHERE meeting_id = ?", [.text(text), .text(op.meetingId)])
                try reindex([op.meetingId])
                let last = try db.query("SELECT seq, id, kind, text FROM pending_ops WHERE meeting_id = ? ORDER BY seq DESC LIMIT 1", [.text(op.meetingId)]).first
                if let last, last[2].string == Op.Kind.setMine.rawValue, let lastId = last[1].string {
                    // a new id, so an ok for the old text (maybe already sent) doesn't clear the new one
                    try db.run("UPDATE op_aliases SET live_id = ? WHERE live_id = ?", [.text(pending.id), .text(lastId)])
                    try db.run("INSERT INTO op_aliases (old_id, live_id, text) VALUES (?, ?, ?)", [.text(lastId), .text(pending.id), .of(last[3].string ?? "")])
                    try db.run("UPDATE pending_ops SET id = ?, text = ? WHERE seq = ?", [.text(pending.id), .text(text), last[0]])
                    return
                }
            }
            try db.run("INSERT INTO pending_ops (id, created_at, kind, meeting_id, folder_id, text, title, base_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                       [.text(pending.id), .real(pending.createdAt.timeIntervalSince1970), .text(op.kind.rawValue), .text(op.meetingId),
                        .of(op.folderId), .of(op.text), .of(op.title), .of(op.baseHash)])
            // rename, trash and restore show at once too, so the phone works the same offline
            if [.rename, .trash, .restore].contains(op.kind) {
                try applyPendingMeetingEdits(op.meetingId)
                try reindex([op.meetingId])
            }
        }
    }

    /// The newest rename and trash/restore still waiting for the desktop, laid over the meeting row.
    private func applyPendingMeetingEdits(_ meetingId: String) throws {
        let rows = try db.query("SELECT kind, title, created_at FROM pending_ops WHERE meeting_id = ? AND kind IN ('rename', 'trash', 'restore') ORDER BY seq",
                                [.text(meetingId)])
        if let title = rows.last(where: { $0[0].string == "rename" })?[1].string {
            try db.run("UPDATE meetings SET title = ? WHERE id = ?", [.text(title), .text(meetingId)])
        }
        guard let last = rows.last(where: { $0[0].string != "rename" }) else { return }
        if last[0].string == "trash" {
            let at: Double = if case .real(let d) = last[2] { d } else { Double(last[2].int ?? 0) }
            try db.run("UPDATE meetings SET trashed_at = COALESCE(trashed_at, ?) WHERE id = ?", [.int(ms(Date(timeIntervalSince1970: at))), .text(meetingId)])
        } else {
            try db.run("UPDATE meetings SET trashed_at = NULL WHERE id = ?", [.text(meetingId)])
        }
    }

    /// Oldest first, the order to send them in.
    public func pendingOps() -> [PendingOp] {
        ((try? db.query("SELECT id, created_at, kind, meeting_id, folder_id, text, title, base_hash FROM pending_ops ORDER BY seq")) ?? [])
            .compactMap { r in
                guard let kind = Op.Kind(rawValue: r[2].string ?? "") else { return nil }
                let createdAt: Double = if case .real(let d) = r[1] { d } else { Double(r[1].int ?? 0) }
                return PendingOp(Op(kind: kind, meetingId: r[3].string ?? "", folderId: r[4].string, text: r[5].string, title: r[6].string, baseHash: r[7].string),
                                 id: r[0].string ?? "", createdAt: Date(timeIntervalSince1970: createdAt))
            }
    }

    /// The desktop said ok to this op. `merged`: its reply said it merged a setMine (both sides had changed).
    public func markSent(_ opId: String, merged: Bool = false) throws {
        try db.transaction {
            try db.run("DELETE FROM pending_ops WHERE id = ?", [.text(opId)])
            if db.changes > 0 {
                try db.run("DELETE FROM op_aliases WHERE live_id = ?", [.text(opId)])
                return
            }
            // it was merged into a newer edit after it was sent: that edit now starts from the text the desktop took
            guard let alias = try db.query("SELECT live_id, text FROM op_aliases WHERE old_id = ?", [.text(opId)]).first else { return }
            if !merged {
                try db.run("UPDATE pending_ops SET base_hash = ? WHERE id = ?", [.text(notesHash(alias[1].string ?? "")), alias[0]])
            }
            try db.run("DELETE FROM op_aliases WHERE old_id = ?", [.text(opId)])
        }
    }

    // MARK: - Recorded on the phone

    /// Keeps (or updates) a recording and shows it as a draft meeting until the desktop sends its own.
    public func saveLocalRecording(_ rec: LocalRecording) throws {
        try db.transaction {
            try db.run("INSERT OR REPLACE INTO local_recordings (id, started_at, data) VALUES (?, ?, ?)",
                       [.text(rec.id), .real(rec.startedAt.timeIntervalSince1970), .text(json(rec))])
            try writeDraft(rec)
        }
    }

    public func localRecordings() -> [LocalRecording] { (try? loadRecordings()) ?? [] }

    /// Throws when SQLite does, so a write built on this list never commits from an empty one. A row that no longer
    /// decodes is logged and kept, for a later build to read.
    private func loadRecordings() throws -> [LocalRecording] {
        try db.query("SELECT id, data FROM local_recordings ORDER BY started_at, id").compactMap { r in
            do { return try JSONDecoder().decode(LocalRecording.self, from: Data((r[1].string ?? "").utf8)) } catch {
                log("a local recording does not decode, id \(r[0].string ?? "")")
                return nil
            }
        }
    }

    public func markUploaded(_ id: String, at: Date = Date()) throws {
        guard var rec = try loadRecordings().first(where: { $0.id == id }) else { return }
        rec.uploadedAt = at
        try db.run("UPDATE local_recordings SET data = ? WHERE id = ?", [.text(json(rec)), .text(id)])
    }

    private func writeDraft(_ rec: LocalRecording) throws {
        // once the desktop sent the meeting, its copy wins
        let source = try db.query("SELECT source FROM meetings WHERE id = ?", [.text(rec.id)]).first?[0].string
        guard source != "desktop" else { return }
        try db.run("INSERT OR REPLACE INTO meetings (id, title, started_at, ended_at, attendees, app, trashed_at, language, source) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'phone')",
                   [.text(rec.id), .text(rec.title), .int(ms(rec.startedAt)), .of(rec.endedAt.map(ms)), .text(json(rec.attendees))])
        // the desktop imports the uploaded My notes, so a setMine made on the draft starts from their hash: the desktop
        // then applies it cleanly instead of adding it again under "From your iPhone"
        try db.run("INSERT OR REPLACE INTO notes (meeting_id, mine, summary, mine_hash, summary_source) VALUES (?, ?, ?, ?, ?)",
                   [.text(rec.id), .text(try pendingMine(rec.id) ?? rec.myNotes), .of(rec.summary), .text(notesHash(rec.myNotes)),
                    .text(Notes.SummarySource.phoneDraft.rawValue)])
        try writeSegments(rec.id, rec.transcript.map { ($0.startMs, $0.endMs, nil, $0.text) })
        try reindex([rec.id])
    }

    // MARK: - Helpers

    private func writeSegments(_ meetingId: String, _ lines: [(Int, Int, String?, String)]) throws {
        try db.run("DELETE FROM segments WHERE meeting_id = ?", [.text(meetingId)])
        for (i, l) in lines.enumerated() {
            try db.run("INSERT INTO segments (meeting_id, idx, start_ms, end_ms, speaker, text) VALUES (?, ?, ?, ?, ?, ?)",
                       [.text(meetingId), .of(i), .of(l.0), .of(l.1), .of(l.2), .text(l.3)])
        }
    }

    /// The newest My notes queued for the desktop, if any.
    private func pendingMine(_ meetingId: String) throws -> String? {
        try db.query("SELECT text FROM pending_ops WHERE meeting_id = ? AND kind = 'setMine' ORDER BY seq DESC LIMIT 1", [.text(meetingId)]).first?[0].string
    }

    private func meta(_ key: String) -> String? {
        (try? db.query("SELECT value FROM meta WHERE key = ?", [.text(key)]))?.first?[0].string
    }

    private func setMeta(_ key: String, _ value: String) throws {
        try db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [.text(key), .text(value)])
    }
}

private func ms(_ v: Double) -> Int64 { clampedInt64(v) }
private func ms(_ d: Date) -> Int64 { clampedInt64(d.timeIntervalSince1970 * 1000) }
private func date(_ ms: Int64) -> Date { Date(timeIntervalSince1970: Double(ms) / 1000) }
private func json<T: Encodable>(_ v: T) -> String { String(decoding: (try? JSONEncoder().encode(v)) ?? Data("null".utf8), as: UTF8.self) }
