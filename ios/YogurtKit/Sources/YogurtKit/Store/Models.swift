import CryptoKit
import Foundation

// What the phone keeps, and the desktop records it is filled from (app/src/main/companion/records.ts).

public struct Attendee: Sendable, Codable, Hashable {
    public var name: String?
    public var email: String?
    public init(name: String?, email: String?) { self.name = name; self.email = email }
}

public struct Meeting: Sendable, Codable, Identifiable, Hashable {
    public var id: String
    public var title: String
    public var startedAt: Date
    public var endedAt: Date?
    public var attendees: [Attendee]
    public var app: String?
    /// set while it is in the desktop's Trash
    public var trashedAt: Date?
    public var language: String?

    public init(id: String, title: String, startedAt: Date, endedAt: Date?, attendees: [Attendee], app: String?,
                trashedAt: Date?, language: String?) {
        self.id = id; self.title = title; self.startedAt = startedAt; self.endedAt = endedAt; self.attendees = attendees
        self.app = app; self.trashedAt = trashedAt; self.language = language
    }
}

public struct Notes: Sendable, Codable, Identifiable, Hashable {
    public enum SummarySource: String, Sendable, Codable { case desktop, phoneDraft }
    public var meetingId: String
    /// My notes: what the person typed
    public var mine: String
    /// the written notes; nil until written
    public var summary: String?
    /// phoneDraft: written on the phone for a recording the desktop has not written its own notes for yet
    public var summarySource: SummarySource
    public var id: String { meetingId }
}

public struct Segment: Sendable, Codable, Identifiable, Hashable {
    /// its place in the transcript
    public var index: Int
    public var startMs: Int
    public var endMs: Int
    /// "me" on the mic, the call's name for the other side, nil for Them
    public var speaker: String?
    public var text: String
    public var id: Int { index }
}

public struct Folder: Sendable, Codable, Identifiable, Hashable {
    public var id: String
    public var name: String
    public var createdAt: Date
    public init(id: String, name: String, createdAt: Date) { self.id = id; self.name = name; self.createdAt = createdAt }
}

public struct Person: Sendable, Codable, Identifiable, Hashable {
    public var email: String
    /// the name the person gave them on the desktop
    public var displayName: String?
    public var id: String { email }
    public init(email: String, displayName: String?) { self.email = email; self.displayName = displayName }
}

/// The wire `op` body.
public struct Op: Sendable, Codable, Hashable {
    public enum Kind: String, Sendable, Codable { case setMine, rename, addToFolder, removeFromFolder, trash, restore }
    public var kind: Kind
    public var meetingId: String
    public var folderId: String?
    public var text: String?
    public var title: String?
    /// for setMine: the desktop's mineHash the edit started from, so the desktop can tell if both sides changed
    public var baseHash: String?

    public init(kind: Kind, meetingId: String, folderId: String? = nil, text: String? = nil, title: String? = nil, baseHash: String? = nil) {
        self.kind = kind; self.meetingId = meetingId; self.folderId = folderId; self.text = text; self.title = title; self.baseHash = baseHash
    }
}

/// An edit made on the phone, kept until the desktop says ok.
public struct PendingOp: Sendable, Codable, Identifiable, Hashable {
    public var id: String
    public var createdAt: Date
    public var op: Op

    public init(_ op: Op, id: String = UUID().uuidString, createdAt: Date = Date()) {
        self.op = op; self.id = id; self.createdAt = createdAt
    }
}

/// A meeting recorded on the phone, kept (with its audio) until the desktop has it.
public struct LocalRecording: Sendable, Codable, Identifiable, Hashable {
    public struct Line: Sendable, Codable, Hashable {
        public var startMs: Int
        public var endMs: Int
        public var text: String
        public init(startMs: Int, endMs: Int, text: String) { self.startMs = startMs; self.endMs = endMs; self.text = text }
    }
    public var id: String
    public var title: String
    public var startedAt: Date
    public var endedAt: Date?
    public var attendees: [Attendee]
    public var audioURL: URL
    public var myNotes: String
    public var transcript: [Line]
    /// the phone's draft notes
    public var summary: String?
    public var uploadedAt: Date?

    enum CodingKeys: String, CodingKey { case id, title, startedAt, endedAt, attendees, audioPath, myNotes, transcript, summary, uploadedAt }

    /// The app container's path changes with updates and restores, so the audio is kept relative to it.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.path + "/"
        let path = audioURL.standardizedFileURL.path
        try c.encode(path.hasPrefix(home) ? String(path.dropFirst(home.count)) : path, forKey: .audioPath)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encodeIfPresent(endedAt, forKey: .endedAt)
        try c.encode(attendees, forKey: .attendees)
        try c.encode(myNotes, forKey: .myNotes)
        try c.encode(transcript, forKey: .transcript)
        try c.encodeIfPresent(summary, forKey: .summary)
        try c.encodeIfPresent(uploadedAt, forKey: .uploadedAt)
    }

    /// Every field but the id and audio has a default, so a recording saved by an older build still loads.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        // without its audio a recording is nothing to upload; resolving "" would point at the app's home folder
        let path = try c.decode(String.self, forKey: .audioPath)
        guard !path.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .audioPath, in: c, debugDescription: "no audio path") }
        audioURL = path.hasPrefix("/") ? URL(fileURLWithPath: path) : URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(path)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt) ?? Date(timeIntervalSince1970: 0)
        endedAt = try c.decodeIfPresent(Date.self, forKey: .endedAt)
        attendees = try c.decodeIfPresent([Attendee].self, forKey: .attendees) ?? []
        myNotes = try c.decodeIfPresent(String.self, forKey: .myNotes) ?? ""
        transcript = try c.decodeIfPresent([Line].self, forKey: .transcript) ?? []
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        uploadedAt = try c.decodeIfPresent(Date.self, forKey: .uploadedAt)
    }

    public init(id: String, title: String, startedAt: Date, endedAt: Date?, attendees: [Attendee], audioURL: URL,
                myNotes: String, transcript: [Line], summary: String?, uploadedAt: Date? = nil) {
        self.id = id; self.title = title; self.startedAt = startedAt; self.endedAt = endedAt; self.attendees = attendees
        self.audioURL = audioURL; self.myNotes = myNotes; self.transcript = transcript; self.summary = summary; self.uploadedAt = uploadedAt
    }
}

/// sha256 hex of the NFC text, the same as the desktop's notesHash, so the same notes hash the same on both sides.
public func notesHash(_ text: String) -> String {
    SHA256.hash(data: Data(text.precomposedStringWithCanonicalMapping.utf8)).map { String(format: "%02x", $0) }.joined()
}

// MARK: - Desktop records

/// One entry of a `pull` reply. An entity this version doesn't know comes through with no record and is skipped,
/// so a newer desktop doesn't stop an older phone from syncing. A record that doesn't decode never fails the page:
/// it comes through `undecodable`, and the store logs its id and skips it.
public struct Change: Sendable, Codable {
    public enum Record: Sendable {
        case meeting(MeetingRecord), notes(NotesRecord), segments(SegmentsRecord)
        case folder(FolderRecord), folderMembers(FolderMembersRecord), people(PersonRecord)
    }
    public var entity: String
    public var id: String
    public var deleted: Bool
    public var record: Record?
    public var undecodable = false

    enum CodingKeys: String, CodingKey { case entity, id, deleted, record }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entity = (try? c.decodeIfPresent(String.self, forKey: .entity)) ?? ""
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? ""
        deleted = (try? c.decodeIfPresent(Bool.self, forKey: .deleted)) ?? false
        record = nil
        guard !entity.isEmpty, !id.isEmpty else { undecodable = true; return }
        guard !deleted, c.contains(.record) else { return }
        do { record = try Change.record(entity, c) } catch { undecodable = true }
    }

    private static func record(_ entity: String, _ c: KeyedDecodingContainer<CodingKeys>) throws -> Record? {
        switch entity {
        case "meeting": .meeting(try c.decode(MeetingRecord.self, forKey: .record))
        case "notes": .notes(try c.decode(NotesRecord.self, forKey: .record))
        case "segments": .segments(try c.decode(SegmentsRecord.self, forKey: .record))
        case "folder": .folder(try c.decode(FolderRecord.self, forKey: .record))
        case "folderMembers": .folderMembers(try c.decode(FolderMembersRecord.self, forKey: .record))
        case "people": .people(try c.decode(PersonRecord.self, forKey: .record))
        default: nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(entity, forKey: .entity)
        try c.encode(id, forKey: .id)
        if deleted { try c.encode(true, forKey: .deleted) }
        switch record {
        case .meeting(let r): try c.encode(r, forKey: .record)
        case .notes(let r): try c.encode(r, forKey: .record)
        case .segments(let r): try c.encode(r, forKey: .record)
        case .folder(let r): try c.encode(r, forKey: .record)
        case .folderMembers(let r): try c.encode(r, forKey: .record)
        case .people(let r): try c.encode(r, forKey: .record)
        case nil: break
        }
    }
}

/// Times are ms since 1970, as JavaScript numbers.
public struct MeetingRecord: Sendable, Codable {
    public var id: String
    public var title: String?
    public var startedAt: Double
    public var endedAt: Double?
    public var attendees: [Attendee]?
    public var app: String?
    public var trashedAt: Double?
    public var language: String?
}

public struct NotesRecord: Sendable, Codable {
    public var meetingId: String?
    /// nil when the record leaves My notes out: the phone keeps what it has
    public var mine: String?
    public var summary: String?
    /// nil when left out: the hash of `mine` (what the desktop would have sent), else the one kept here
    public var mineHash: String?
}

public struct SegmentsRecord: Sendable, Codable {
    public struct Line: Sendable, Codable {
        public var startMs: Double
        public var endMs: Double
        public var speaker: String?
        public var text: String
    }
    public var meetingId: String
    public var segments: [Line]
}

public struct FolderRecord: Sendable, Codable {
    public var id: String
    public var name: String
    public var createdAt: Double
}

public struct FolderMembersRecord: Sendable, Codable {
    public var folderId: String
    public var meetingIds: [String]
}

public struct PersonRecord: Sendable, Codable {
    public var email: String
    public var displayName: String?
}
