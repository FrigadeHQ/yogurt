import Foundation

/// The files the Note's Share makes, in the shape desktop's Save Markdown writes (app/src/shared/exportNotes.ts): a
/// title, the date, who was there, then the notes or the transcript, and a small credit so whoever gets the file can
/// find the app. The words come in translated, so this stays plain text work.
public struct ShareExport: Sendable {
    public struct Labels: Sendable {
        public var myNotes, transcript, you, them, meeting: String
        /// "With: Maya, Sam"
        public var with: @Sendable (String) -> String
        /// "Recorded with <app>"
        public var recordedWith: @Sendable (String) -> String
        public init(myNotes: String, transcript: String, you: String, them: String, meeting: String,
                    with: @escaping @Sendable (String) -> String, recordedWith: @escaping @Sendable (String) -> String) {
            self.myNotes = myNotes; self.transcript = transcript; self.you = you; self.them = them; self.meeting = meeting
            self.with = with; self.recordedWith = recordedWith
        }
    }

    public static let website = "https://yogurt.so"
    /// a pause this long starts a new turn, so the time shows again (desktop's NEW_TURN_AFTER_MS)
    static let newTurnAfterMs = 30_000
    /// one voice talking on (an iPhone recording is all one voice) gets a new paragraph and time every minute, so a
    /// long recording isn't one huge block
    static let splitTurnAfterMs = 60_000

    let meeting: Meeting
    let labels: Labels
    let locale: Locale
    let timeZone: TimeZone

    public init(meeting: Meeting, labels: Labels, locale: Locale = .current, timeZone: TimeZone = .current) {
        self.meeting = meeting; self.labels = labels; self.locale = locale; self.timeZone = timeZone
    }

    /// The summary, then My notes under their own heading.
    public func summary(summary: String?, mine: String) -> String {
        var out = [head]
        let body = (summary ?? "").replacingOccurrences(of: "</?mine>", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !body.isEmpty { out.append(body) }
        let own = mine.replacingOccurrences(of: "</?mine>", with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        if !own.isEmpty { out.append("## \(labels.myNotes)\n\n\(own)") }
        out.append(credit)
        return out.joined(separator: "\n\n") + "\n"
    }

    /// The transcript as desktop writes it: a bold name and the time, a blank line, then what they said.
    public func transcript(_ segments: [Segment]) -> String {
        var out = [head, "## \(labels.transcript)"]
        for turn in turns(segments) {
            let time = Self.clock(turn.startMs)
            out.append(meeting.oneMic ? "**\(time)**" : "**\(Self.escape(speaker(turn.speaker)))** (\(time))")
            out.append(Self.escapeStart(Self.escape(turn.text)))
        }
        out.append(credit)
        return out.joined(separator: "\n\n") + "\n"
    }

    /// "<title> <day>[ <suffix>].<ext>" with nothing a file name cannot hold; never a hidden file or a very long one.
    public static func fileName(title: String, startedAt: Date, suffix: String? = nil, ext: String, fallback: String,
                                calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: startedAt)
        let day = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
        let clean = title.replacingOccurrences(of: #"[\\/:*?"<>|\u0000-\u001f]"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: #"^\.+|\.+$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        // Characters are whole graphemes, so the cut never splits an emoji
        let short = String(clean.prefix(80)).trimmingCharacters(in: .whitespaces)
        let name = [short.isEmpty ? fallback : short, day, suffix].compactMap { $0 }.joined(separator: " ")
        return "\(name).\(ext)"
    }

    // MARK: - Pieces

    private var head: String {
        let title = meeting.title.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        let when = meeting.startedAt.formatted(Date.FormatStyle(date: .long, time: .shortened, locale: locale, timeZone: timeZone))
        var lines = ["# \(Self.escape(title.isEmpty ? labels.meeting : title))", "", when]
        let people = meeting.attendees.compactMap { $0.name?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if !people.isEmpty { lines += ["", labels.with(people.joined(separator: ", "))] }
        return lines.joined(separator: "\n")
    }

    private var credit: String { labels.recordedWith("[Yogurt](\(Self.website))") }

    private func speaker(_ s: String?) -> String {
        switch s {
        case "me": labels.you
        case nil: labels.them
        case let name?: name
        }
    }

    /// Lines in a row from the same voice, unless a long pause comes between them, like desktop's turns(), and a new
    /// one each minute.
    private func turns(_ segments: [Segment]) -> [(speaker: String?, startMs: Int, text: String)] {
        var out: [(speaker: String?, startMs: Int, text: String, endMs: Int)] = []
        for s in segments.sorted(by: { ($0.startMs, $0.index) < ($1.startMs, $1.index) }) {
            let text = s.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            if let last = out.last, last.speaker == s.speaker, s.startMs - last.endMs < Self.newTurnAfterMs,
               s.startMs - last.startMs < Self.splitTurnAfterMs {
                out[out.count - 1].text += " " + text
                out[out.count - 1].endMs = s.endMs
            } else {
                out.append((s.speaker, s.startMs, text, s.endMs))
            }
        }
        return out.map { ($0.speaker, $0.startMs, $0.text) }
    }

    /// Meeting time as m:ss, or h:mm:ss past the first hour.
    static func clock(_ ms: Int) -> String {
        let s = max(0, ms) / 1000
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    /// Markdown's own characters made literal, as desktop's escapeText.
    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: #"([\\*_\[\]])"#, with: #"\\$1"#, options: .regularExpression)
    }

    /// A line that starts like a heading or a list item stays a paragraph.
    static func escapeStart(_ s: String) -> String {
        s.replacingOccurrences(of: #"^(\s*)([#+-])"#, with: #"$1\\$2"#, options: .regularExpression)
            .replacingOccurrences(of: #"^(\s*\d+)([.)])(?=\s)"#, with: #"$1\\$2"#, options: .regularExpression)
    }
}
