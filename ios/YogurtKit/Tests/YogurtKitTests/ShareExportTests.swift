import Foundation
import Testing
@testable import YogurtKit

/// The files Share makes, in the shape desktop's Save Markdown writes (app/src/shared/exportNotes.ts).
@Suite struct ShareExportTests {
    static let labels = ShareExport.Labels(myNotes: "My notes", transcript: "Transcript", you: "You", them: "Them",
                                           meeting: "Meeting", with: { "With: \($0)" }, recordedWith: { "Recorded with \($0)" })
    static let utc = TimeZone(identifier: "UTC")!
    static let en = Locale(identifier: "en_US")
    /// how the date line reads: a long date and a short time, as desktop writes it
    static var when: String { day(2026, 10, 29).formatted(Date.FormatStyle(date: .long, time: .shortened, locale: en, timeZone: utc)) }

    static func day(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 10) -> Date {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = utc
        return c.date(from: DateComponents(year: y, month: m, day: d, hour: h))!
    }

    static let meeting = Meeting(id: "m1", title: "Weekly sync", startedAt: day(2026, 10, 29), endedAt: nil,
                                 attendees: [Attendee(name: "Maya Chen", email: nil), Attendee(name: " ", email: "x@y.z"), Attendee(name: "Sam", email: nil)],
                                 app: nil, trashedAt: nil, language: nil)

    static func seg(_ i: Int, _ startMs: Int, _ text: String, _ speaker: String? = nil) -> Segment {
        Segment(index: i, startMs: startMs, endMs: startMs + 2000, speaker: speaker, text: text)
    }

    static let segments = [seg(0, 0, "Hi all.", "me"), seg(1, 3000, "Starting now.", "me"), seg(2, 6000, "Hello *there*", "Maya"),
                           seg(3, 70_000, "Hm.")]

    func export(_ meeting: Meeting = meeting) -> ShareExport {
        ShareExport(meeting: meeting, labels: Self.labels, locale: Self.en, timeZone: Self.utc)
    }

    // MARK: - File names

    @Test func fileNameIsTheTitleAndDayWithoutWhatAFileNameCannotHold() {
        let cal = { var c = Calendar(identifier: .gregorian); c.timeZone = Self.utc; return c }()
        #expect(ShareExport.fileName(title: "Q3 / plan: \"draft\"?", startedAt: Self.day(2026, 10, 29), ext: "md", fallback: "Meeting", calendar: cal) == "Q3 plan draft 2026-10-29.md")
        #expect(ShareExport.fileName(title: "   ", startedAt: Self.day(2026, 10, 5), ext: "md", fallback: "Meeting", calendar: cal) == "Meeting 2026-10-05.md")
        #expect(ShareExport.fileName(title: ".hidden..", startedAt: Self.day(2026, 10, 5), ext: "m4a", fallback: "Meeting", calendar: cal) == "hidden 2026-10-05.m4a")
        #expect(ShareExport.fileName(title: "Plan", startedAt: Self.day(2026, 10, 5), suffix: "Transcript", ext: "md", fallback: "Meeting", calendar: cal) == "Plan 2026-10-05 Transcript.md")
        #expect(ShareExport.fileName(title: String(repeating: "x", count: 300), startedAt: Self.day(2026, 1, 1), ext: "md", fallback: "Meeting", calendar: cal).count < 120)
    }

    @Test func aLongNameIsCutAtAWholeCharacter() {
        let name = ShareExport.fileName(title: String(repeating: "😀", count: 200), startedAt: Self.day(2026, 1, 1), ext: "md", fallback: "Meeting")
        #expect(name.unicodeScalars.allSatisfy { !(0xD800...0xDFFF).contains($0.value) })
        #expect(name.hasPrefix(String(repeating: "😀", count: 80) + " "))
    }

    // MARK: - Summary

    @Test func summaryHasTitleDatePeopleSummaryThenMyNotesThenTheCredit() {
        let md = export().summary(summary: "## Plan\n- ship", mine: "<mine>call Maya</mine>")
        let order = ["# Weekly sync", "October 29, 2026", "With: Maya Chen, Sam", "## Plan\n- ship", "## My notes\n\ncall Maya", "Recorded with [Yogurt](https://yogurt.so)"]
        let at = order.map { md.range(of: $0)?.lowerBound }
        #expect(at.allSatisfy { $0 != nil }, "\(md)")
        #expect(at.compactMap { $0 } == at.compactMap { $0 }.sorted())
        #expect(md.hasSuffix("Recorded with [Yogurt](https://yogurt.so)\n"))
        #expect(!md.contains("<mine>"))
    }

    @Test func summaryWithoutMyNotesOrPeopleLeavesThemOut() {
        var m = Self.meeting
        m.attendees = []
        let md = export(m).summary(summary: "## Plan\n- ship", mine: "  \n")
        #expect(!md.contains("My notes"))
        #expect(!md.contains("With:"))
        #expect(md.hasPrefix("# Weekly sync\n\n\(Self.when)\n\n## Plan\n- ship\n\n"))
    }

    @Test func theTitleIsWrittenAsTypedWithMarkdownCharactersMadeLiteral() {
        var m = Self.meeting
        m.title = "Q3 *plan* [x]"
        #expect(export(m).summary(summary: "n", mine: "").hasPrefix("# Q3 \\*plan\\* \\[x\\]\n"))
        m.title = "  "
        #expect(export(m).summary(summary: "n", mine: "").hasPrefix("# Meeting\n"))
    }

    // MARK: - Transcript

    @Test func transcriptGivesEachTurnANameAndTimeLikeDesktop() {
        let md = export().transcript(Self.segments)
        #expect(md.hasPrefix("# Weekly sync\n\n\(Self.when)\n\nWith: Maya Chen, Sam\n\n## Transcript\n\n"))
        #expect(md.contains("**You** (0:00)\n\nHi all. Starting now.\n\n**Maya** (0:06)\n\nHello \\*there\\*\n\n**Them** (1:10)\n\nHm."))
        #expect(md.hasSuffix("Hm.\n\nRecorded with [Yogurt](https://yogurt.so)\n"))
    }

    @Test func aLongPauseStartsANewTurnSoTheTimeShowsAgain() {
        let md = export().transcript([Self.seg(0, 0, "One.", "me"), Self.seg(1, 40_000, "Two.", "me"), Self.seg(2, 3_725_000, "Late.", "me")])
        #expect(md.contains("**You** (0:00)\n\nOne.\n\n**You** (0:40)\n\nTwo.\n\n**You** (1:02:05)\n\nLate."))
    }

    @Test func aLongStretchOfOneVoiceIsSplitEveryMinuteSoTimesShow() {
        // an iPhone recording is one voice with no long pauses: it used to come out as one huge block
        var m = Self.meeting
        m.oneMic = true
        let lines = (0..<30).map { Self.seg($0, $0 * 10_000, "Line \($0).") }
        let md = export(m).transcript(lines)
        #expect(md.contains("**0:00**\n\nLine 0. Line 1. Line 2. Line 3. Line 4. Line 5.\n\n**1:00**\n\nLine 6."))
        #expect(md.contains("**4:00**\n\nLine 24."))
    }

    @Test func oneMicTurnsHaveTheTimeOnly() {
        var m = Self.meeting
        m.oneMic = true
        let md = export(m).transcript([Self.seg(0, 0, "One."), Self.seg(1, 3000, "Two."), Self.seg(2, 65_000, "Three.")])
        #expect(md.contains("**0:00**\n\nOne. Two.\n\n**1:05**\n\nThree."))
        #expect(!md.contains("Them"))
    }

    @Test func linesAreSortedAndBlankOnesSkipped() {
        let md = export().transcript([Self.seg(1, 5000, "Second.", "me"), Self.seg(0, 0, "First.", "me"), Self.seg(2, 6000, "  ", "me")])
        #expect(md.contains("**You** (0:00)\n\nFirst. Second.\n\nRecorded"))
    }

    @Test func aLineThatLooksLikeMarkdownStaysText() {
        let md = export().transcript([Self.seg(0, 0, "# not a heading", "me"), Self.seg(1, 60_000, "- not a bullet", "Leo"), Self.seg(2, 120_000, "1. not a list", "Ann")])
        #expect(md.contains("\n\n\\# not a heading\n\n"))
        #expect(md.contains("\n\n\\- not a bullet\n\n"))
        #expect(md.contains("\n\n1\\. not a list\n\n"))
    }
}
