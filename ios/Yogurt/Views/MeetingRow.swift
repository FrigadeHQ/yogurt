import SwiftUI
import YogurtKit

/// One meeting in the list, laid out like desktop's meeting card: a tile, the title over who was there, and the time.
struct MeetingRow: View {
    let meeting: Meeting
    var folders: [Folder] = []
    /// in place of who was there: "Recorded on this iPhone · waiting for your computer"
    var detail: String? = nil

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            MeetingTile(attendees: meeting.attendees)
            VStack(alignment: .leading, spacing: 3) {
                Text(meeting.title.isEmpty ? S.personalNotes : meeting.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                Text(detail ?? Format.people(meeting.attendees))
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                if !folders.isEmpty {
                    HStack(spacing: 6) { ForEach(folders) { MeetingFolderLabel(name: $0.name) } }
                        .padding(.top, 4)
                }
                if typeSize.isAccessibilitySize { time }
            }
            if !typeSize.isAccessibilitySize {
                Spacer(minLength: 4)
                time
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .accessibilityElement(children: .combine)
    }

    private var time: some View {
        VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 4) {
            Text(Format.time(meeting.startedAt))
                .font(.footnote.monospacedDigit())
            if let d = Format.duration(meeting) {
                Text(d).font(.caption.monospacedDigit())
            }
        }
        .foregroundStyle(Theme.muted)
    }
}

/// desktop's `.meeting-identity`: initials for one person, people for a group, a page for personal notes
struct MeetingTile: View {
    let attendees: [Attendee]
    var body: some View {
        Group {
            if let initials = Format.initials(attendees) {
                Text(initials).font(.caption.weight(.semibold))
            } else {
                Image(systemName: attendees.count > 1 ? "person.2" : "doc.text").font(.system(size: 15, weight: .regular))
            }
        }
        .foregroundStyle(Theme.written)
        .frame(width: 38, height: 38)
        .background(Theme.card, in: Circle())
        .accessibilityHidden(true)
    }
}

/// A folder name under a meeting title.
struct MeetingFolderLabel: View {
    let name: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(Theme.accent).frame(width: 6, height: 6)
            Text(name).lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(Theme.written)
    }
}

#Preview {
    let start = Date().addingTimeInterval(-3600)
    VStack(spacing: 0) {
        MeetingRow(meeting: Meeting(id: "1", title: "Weekly product sync", startedAt: start, endedAt: start.addingTimeInterval(2520),
                                    attendees: [Attendee(name: "Maya Chen", email: nil), Attendee(name: "Leo Park", email: nil)],
                                    app: "Zoom", trashedAt: nil, language: nil),
                   folders: [Folder(id: "f", name: "Product", createdAt: start)])
        MeetingRow(meeting: Meeting(id: "2", title: "Coffee with Priya", startedAt: start, endedAt: nil,
                                    attendees: [Attendee(name: "Priya Nair", email: nil)], app: nil, trashedAt: nil, language: nil))
    }
    .padding()
}
