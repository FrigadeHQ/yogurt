#if DEBUG
import Foundation
import YogurtKit

/// Made-up meetings for trying the app before it is paired. Names and companies are invented.
enum SampleData {
    private struct Sample {
        var id: String
        var title: String
        /// days before today, and the time of day
        var daysAgo: Int, hour: Int, minute: Int
        var minutes: Int
        var people: [String]
        var app: String?
        var mine: String
        var summary: String?
        var transcript: [(String?, String)]
        var folders: [String] = []
    }

    private static let folders = [("product", "Product"), ("hiring", "Hiring"), ("one-on-ones", "1:1s")]

    private static let samples: [Sample] = [
        Sample(id: "sample-product-sync", title: "Weekly product sync", daysAgo: 0, hour: 10, minute: 0, minutes: 42,
               people: ["Maya Chen", "Leo Park", "Sam Rivera"], app: "Zoom",
               mine: "- ask Leo about the beta numbers\n- pricing page copy?",
               summary: """
               ## Where things stand
               - The beta has **412 active people**, up from 280 last week.
               - Sign-up drop-off is mostly on the email step.
               - The pricing page is still waiting on final copy.

               ## Decisions
               - Ship the shorter sign-up on **Thursday**.
               - Keep the beta invite-only until the end of the month.

               ## Next steps
               - Leo shares the full beta numbers by Wednesday.
               - Sam writes the pricing page copy.
               - Maya books a design review for onboarding.
               """,
               transcript: [
                   ("me", "Okay, let's start with the beta. Leo, how are we looking?"),
                   ("Leo Park", "Good week. We're at four hundred and twelve active people, up from about two eighty."),
                   ("Maya Chen", "Nice. Is the drop-off still on sign-up?"),
                   ("Leo Park", "Mostly the email step. People leave when we ask them to confirm."),
                   ("me", "Then let's ship the shorter sign-up. Can we do Thursday?"),
                   ("Sam Rivera", "Thursday works. I still owe you the pricing page copy, I'll have it this week."),
                   ("Maya Chen", "I'll set up a design review for onboarding too."),
               ],
               folders: ["product"]),
        Sample(id: "sample-coffee", title: "Coffee with Priya", daysAgo: 0, hour: 8, minute: 30, minutes: 25,
               people: ["Priya Nair"], app: nil,
               mine: "Priya is moving to the platform team in January.",
               summary: """
               ## Catch-up
               - Priya moves to the platform team in **January**.
               - She'd like to keep mentoring the two new hires.
               - Suggested a monthly lunch for the design crew.

               ## Follow-ups
               - Introduce Priya to Jonas on platform.
               """,
               transcript: [
                   ("Priya Nair", "So the big news is I'm moving to platform in January."),
                   ("me", "Congrats! Are you still up for mentoring the new folks?"),
                   ("Priya Nair", "Definitely. And we should do a monthly lunch for the design crew."),
               ],
               folders: ["one-on-ones"]),
        Sample(id: "sample-design-review", title: "Design review: onboarding", daysAgo: 1, hour: 15, minute: 0, minutes: 55,
               people: ["Maya Chen", "Amara Okafor"], app: "Google Meet",
               mine: "",
               summary: """
               ## Feedback
               - The welcome screen says too much: cut it to **one sentence**.
               - People miss the skip link. Make it a real button.
               - The progress dots work well, keep them.

               ## Decisions
               1. Amara redraws the welcome screen.
               2. The skip button ships with the shorter sign-up.
               """,
               transcript: [
                   ("Amara Okafor", "Here's the new welcome screen. I tried to keep it light."),
                   ("Maya Chen", "It's nice, but there's a lot of text. Could it be one sentence?"),
                   ("me", "Agreed. And in testing, nobody found the skip link."),
                   ("Amara Okafor", "Fair. I'll make it a proper button and redraw the welcome."),
               ],
               folders: ["product"]),
        Sample(id: "sample-interview-frontend", title: "Interview: frontend engineer", daysAgo: 2, hour: 13, minute: 0, minutes: 48,
               people: ["Jonas Weber", "Elena Ruiz"], app: "Zoom",
               mine: "Strong on accessibility. Ask about testing in round two.",
               summary: """
               ## Strengths
               - Clear about **accessibility**, with real examples.
               - Explained trade-offs calmly.

               ## Open questions
               - How they approach testing.
               - Interest in mobile work.
               """,
               transcript: [
                   ("Jonas Weber", "Tell us about a project you're proud of."),
                   (nil, "I rebuilt a checkout flow so it works well with screen readers."),
                   ("me", "What did you learn from that?"),
                   (nil, "Mostly that small details, like focus order, matter a lot."),
               ],
               folders: ["hiring"]),
        Sample(id: "sample-one-on-one", title: "1:1 with Leo", daysAgo: 3, hour: 11, minute: 30, minutes: 30,
               people: ["Leo Park"], app: "Zoom",
               mine: "- Leo wants more time for the data work\n- check in on workload",
               summary: """
               ## Notes
               - Leo wants to spend Fridays on the data clean-up.
               - Workload is fine, but on-call last week was heavy.

               ## Next steps
               - Move Leo's on-call to the next rotation.
               """,
               transcript: [
                   ("Leo Park", "I'd love to keep Fridays for the data clean-up."),
                   ("me", "That's fair. How was on-call?"),
                   ("Leo Park", "Heavy, honestly. Three pages in one night."),
               ],
               folders: ["one-on-ones"]),
        Sample(id: "sample-planning", title: "Quarterly planning", daysAgo: 6, hour: 9, minute: 0, minutes: 80,
               people: ["Maya Chen", "Leo Park", "Sam Rivera", "Priya Nair", "Amara Okafor"], app: "Microsoft Teams",
               mine: "",
               summary: """
               ## Goals for the quarter
               - Grow weekly active people to **2,000**.
               - Launch the iPhone app.
               - Halve the time to the first summary.

               ## Risks
               - Hiring two engineers takes longer than planned.
               """,
               transcript: [
                   ("Maya Chen", "Let's agree on three goals, no more."),
                   ("me", "Growth, the iPhone app, and speed."),
                   ("Sam Rivera", "Speed meaning the time to the first summary?"),
                   ("me", "Exactly. Let's try to halve it."),
               ]),
        Sample(id: "sample-pricing-notes", title: "Notes on the pricing page", daysAgo: 10, hour: 17, minute: 15, minutes: 12,
               people: [], app: nil,
               mine: "Free stays free. Keep the page short: one plan, one sentence about privacy.",
               summary: """
               ## Ideas
               - One plan, explained in a sentence.
               - Say clearly that **everything stays on your computer**.
               """,
               transcript: [("me", "Thinking out loud about the pricing page. It should be short.")]),
        Sample(id: "sample-customer-call", title: "Customer call: Northwind", daysAgo: 16, hour: 14, minute: 0, minutes: 35,
               people: ["Grace Holm", "Tomás Silva"], app: "Zoom",
               mine: "They want a shared folder for the sales team.",
               summary: """
               ## What they asked for
               - A way to share a folder of meetings with their sales team.
               - Export to their notes app.

               ## Next steps
               - Send them the export guide.
               """,
               transcript: [
                   ("Grace Holm", "Our sales team would love a shared folder."),
                   ("me", "Got it. Would exporting to your notes app help for now?"),
                   ("Tomás Silva", "That would help a lot."),
               ],
               folders: ["product"]),
        Sample(id: "sample-interview-designer", title: "Interview: product designer", daysAgo: 40, hour: 10, minute: 0, minutes: 50,
               people: ["Jonas Weber"], app: "Google Meet",
               mine: "",
               summary: nil,
               transcript: [("Jonas Weber", "Walk us through your portfolio.")],
               folders: ["hiring"]),
    ]

    /// The samples as one pull page.
    static func changes(now: Date = Date()) -> [Change] {
        var out: [[String: Any]] = []
        let calendar = Calendar.current
        for s in samples {
            let day = calendar.date(byAdding: .day, value: -s.daysAgo, to: now) ?? now
            let start = calendar.date(bySettingHour: s.hour, minute: s.minute, second: 0, of: day) ?? day
            // a meeting "today" that would start later than now is moved back so it has already happened
            let started = start > now ? now.addingTimeInterval(-Double(s.minutes + 20) * 60) : start
            let startMs = started.timeIntervalSince1970 * 1000
            let attendees = s.people.map { name in
                ["name": name, "email": name.lowercased().replacingOccurrences(of: " ", with: ".") + "@example.com"]
            }
            out.append(["entity": "meeting", "id": s.id, "record": [
                "id": s.id, "title": s.title, "startedAt": startMs, "endedAt": startMs + Double(s.minutes) * 60_000,
                "attendees": attendees, "app": s.app ?? NSNull(), "trashedAt": NSNull(), "language": "en",
            ] as [String: Any]])
            out.append(["entity": "notes", "id": s.id, "record": [
                "meetingId": s.id, "mine": s.mine, "summary": s.summary ?? NSNull(), "mineHash": notesHash(s.mine),
            ] as [String: Any]])
            let step = Double(s.minutes) * 60_000 / Double(max(s.transcript.count, 1))
            out.append(["entity": "segments", "id": s.id, "record": [
                "meetingId": s.id,
                "segments": s.transcript.enumerated().map { i, line in
                    ["startMs": Double(i) * step, "endMs": Double(i) * step + 8000, "speaker": line.0 ?? NSNull(), "text": line.1] as [String: Any]
                },
            ] as [String: Any]])
        }
        for (id, name) in folders {
            out.append(["entity": "folder", "id": id, "record": ["id": id, "name": name, "createdAt": 1_700_000_000_000.0]])
            out.append(["entity": "folderMembers", "id": id, "record": [
                "folderId": id, "meetingIds": samples.filter { $0.folders.contains(id) }.map(\.id),
            ] as [String: Any]])
        }
        for s in samples { for name in s.people {
            let email = name.lowercased().replacingOccurrences(of: " ", with: ".") + "@example.com"
            out.append(["entity": "people", "id": email, "record": ["email": email, "displayName": name]])
        } }
        guard let data = try? JSONSerialization.data(withJSONObject: out) else { return [] }
        return (try? JSONDecoder().decode([Change].self, from: data)) ?? []
    }
}
#endif
