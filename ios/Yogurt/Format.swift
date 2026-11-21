import Foundation
import YogurtKit

/// Dates, durations and people, written the way desktop Yogurt writes them (app/src/shared/dates.ts).
enum Format {
    /// "Today", "Yesterday", a weekday this week, else "Tue, Nov 4" (with the year when it isn't this one).
    static func day(_ date: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: cal.startOfDay(for: now)).day ?? 0
        if days == 0 { return S.today }
        if days == 1 { return S.yesterday }
        if days > 1 && days < 7 { return date.formatted(.dateTime.weekday(.wide)) }
        let sameYear = cal.component(.year, from: date) == cal.component(.year, from: now)
        return sameYear ? date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
            : date.formatted(.dateTime.month(.abbreviated).day().year())
    }

    static func time(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }

    static func duration(_ m: Meeting) -> String? {
        guard let end = m.endedAt else { return nil }
        return S.minutes(max(1, Int((end.timeIntervalSince(m.startedAt) / 60).rounded())))
    }

    /// First names, up to three, then "+ n".
    static func people(_ attendees: [Attendee], limit: Int = 3) -> String {
        let names = attendees.compactMap { a in
            (a.name?.split(separator: " ").first).map(String.init) ?? a.email
        }
        guard !names.isEmpty else { return S.personalNotes }
        let shown = names.prefix(limit).joined(separator: ", ")
        return names.count > limit ? S.andMore(shown, names.count - limit) : shown
    }

    /// Two letters for one person, like desktop's meeting tile.
    static func initials(_ attendees: [Attendee]) -> String? {
        guard attendees.count == 1, let name = attendees[0].name else { return nil }
        let letters = name.split(separator: " ").prefix(2).compactMap(\.first)
        return letters.isEmpty ? nil : String(letters).uppercased()
    }

    /// "3:05" into a transcript.
    static func offset(_ ms: Int) -> String {
        let s = ms / 1000
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    static func bytes(_ n: Int64) -> String { n.formatted(.byteCount(style: .file)) }
}
