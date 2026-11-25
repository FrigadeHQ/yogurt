import Foundation
import Testing
@testable import YogurtKit

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }
private func ok(_ b: Bool, _ loc: SourceLocation = #_sourceLocation) { #expect(b, sourceLocation: loc) }
private func no(_ b: Bool, _ loc: SourceLocation = #_sourceLocation) { #expect(!b, sourceLocation: loc) }

@Suite struct RecordingStateTests {
    @Test func countsOnlyTheTimeRecorded() {
        var r = RecordingState()
        #expect(r.phase == .idle)
        ok(r.begin())
        #expect(r.phase == .starting)
        ok(r.started(at: at(0)))
        #expect(r.elapsed(at: at(30)) == 30)
        ok(r.pause(.byYou, at: at(30)))
        #expect(r.elapsed(at: at(90)) == 30)
        ok(r.resume(at: at(90)))
        #expect(r.elapsed(at: at(100)) == 40)
        ok(r.stop(at: at(100)))
        #expect(r.phase == .stopping)
        #expect(r.elapsed(at: at(500)) == 40)
        ok(r.finished())
        #expect(r.phase == .finished)
    }

    @Test func aCallPausesAndItsEndResumes() {
        var r = RecordingState()
        _ = r.begin(); _ = r.started(at: at(0))
        ok(r.pause(.interrupted, at: at(10)))
        #expect(r.phase == .paused(.interrupted))
        ok(r.interruptionEnded(at: at(70)))
        #expect(r.phase == .recording)
        #expect(r.elapsed(at: at(80)) == 20)
    }

    @Test func aCallWhilePausedByYouStaysPausedAfterIt() {
        var r = RecordingState()
        _ = r.begin(); _ = r.started(at: at(0))
        _ = r.pause(.byYou, at: at(5))
        // already paused: a call doesn't take over the pause
        no(r.pause(.interrupted, at: at(6)))
        no(r.interruptionEnded(at: at(9)))
        #expect(r.phase == .paused(.byYou))
    }

    @Test func eventsOutOfOrderAreRefused() {
        var r = RecordingState()
        no(r.started(at: at(0)))
        no(r.pause(.byYou, at: at(0)))
        no(r.resume(at: at(0)))
        no(r.stop(at: at(0)))
        _ = r.begin()
        no(r.begin())
        _ = r.started(at: at(0))
        no(r.resume(at: at(1)))
        _ = r.stop(at: at(2))
        no(r.pause(.byYou, at: at(3)))
        no(r.stop(at: at(3)))
    }

    @Test func stoppingWhilePausedKeepsTheTimeSoFar() {
        var r = RecordingState()
        _ = r.begin(); _ = r.started(at: at(0))
        _ = r.pause(.interrupted, at: at(12))
        ok(r.stop(at: at(50)))
        #expect(r.elapsed(at: at(60)) == 12)
    }

    @Test func aFailedStartCanStartAgain() {
        var r = RecordingState()
        _ = r.begin()
        r.fail("The microphone is off.")
        #expect(r.phase == .failed("The microphone is off."))
        ok(r.begin())
    }
}

@Suite struct LiveTranscriptTests {
    @Test func changingLanguagesKeepsTheLastWordsAndContinuesOnTheAudioTimeline() {
        var t = LiveTranscript()
        t.update("one moment", startMs: 300, endMs: 900, isFinal: false)
        t.restart(at: 1000)
        t.update("bonjour", startMs: 100, endMs: 900, isFinal: true)
        #expect(t.settled == [.init(startMs: 300, endMs: 900, text: "one moment"),
                              .init(startMs: 1100, endMs: 1900, text: "bonjour")])
    }

    @Test func volatileTextIsReplacedThenSettles() {
        var t = LiveTranscript()
        t.update("we ship", startMs: 0, endMs: 900, isFinal: false)
        t.update("we ship on thurs", startMs: 0, endMs: 1500, isFinal: false)
        #expect(t.lines.isEmpty)
        #expect(t.volatile == "we ship on thurs")
        t.update("We ship on Thursday.", startMs: 0, endMs: 1800, isFinal: true)
        #expect(t.volatile == "")
        #expect(t.lines == [.init(startMs: 0, endMs: 1800, text: "We ship on Thursday.")])
    }

    @Test func fragmentsOfOneSentenceJoinOneLine() {
        var t = LiveTranscript()
        t.update("So the plan is", startMs: 0, endMs: 1200, isFinal: true)
        t.update("to ship on Thursday.", startMs: 1300, endMs: 2600, isFinal: true)
        t.update("Maya writes the post.", startMs: 2700, endMs: 4000, isFinal: true)
        #expect(t.lines == [
            .init(startMs: 0, endMs: 2600, text: "So the plan is to ship on Thursday."),
            .init(startMs: 2700, endMs: 4000, text: "Maya writes the post."),
        ])
    }

    @Test func aLongPauseStartsANewLine() {
        var t = LiveTranscript()
        t.update("Okay so", startMs: 0, endMs: 800, isFinal: true)
        t.update("next topic", startMs: 6000, endMs: 7000, isFinal: true)
        #expect(t.lines.count == 2)
    }

    @Test func emptyResultsAndOverlapsAreTidied() {
        var t = LiveTranscript()
        t.update("  ", startMs: 0, endMs: 500, isFinal: true)
        #expect(t.lines.isEmpty)
        t.update("First.", startMs: 0, endMs: 2000, isFinal: true)
        // a restarted recogniser can report a start before the last end
        t.update("Second.", startMs: 1500, endMs: 3000, isFinal: true)
        #expect(t.lines[1].startMs == 2000)
        #expect(t.lines.allSatisfy { $0.endMs >= $0.startMs })
    }

    @Test func savedLinesIncludeWhatIsStillBeingHeard() {
        var t = LiveTranscript()
        t.update("Done.", startMs: 0, endMs: 1000, isFinal: true)
        t.update("and one more", startMs: 1100, endMs: 2000, isFinal: false)
        #expect(t.settled.map(\.text) == ["Done.", "and one more"])
        #expect(t.lines.count == 1)
    }

    @Test func aVeryLongRunIsSplitIntoReadableLines() {
        var t = LiveTranscript()
        for i in 0..<40 { t.update("and then we talked about item \(i)", startMs: i * 1000, endMs: i * 1000 + 900, isFinal: true) }
        #expect(t.lines.count > 1)
        #expect(t.lines.allSatisfy { $0.text.count <= LiveTranscript.maxLine + 60 })
    }
}

@Suite struct LevelTests {
    @Test func dbfsMapsLikeDesktop() {
        #expect(micLevel(dbfs: -80) == 0)
        #expect(micLevel(dbfs: -51) < 1e-9)
        #expect(abs(micLevel(dbfs: -12) - 1) < 0.0001)
        #expect(micLevel(dbfs: 0) == 1)
        #expect(micLevel(dbfs: -.infinity) == 0)
        #expect(micLevel(dbfs: .nan) == 0)
        // quiet speech gets more travel
        #expect(micLevel(dbfs: -40) > (-40 + 51) / 39.0)
        #expect(micLevel(dbfs: -30) < micLevel(dbfs: -20))
    }

    @Test func waveRisesQuicklyAndFallsGently() {
        var w = Wave()
        w.target = 1
        w.step(60)
        #expect(w.level > 0.6)
        w.target = 0
        let before = w.level
        w.step(60)
        #expect(w.level < before && w.level > before * 0.6)
        for _ in 0..<100 { w.step(50) }
        #expect(w.level == 0)
    }

    @Test func rmsOfSilenceAndASine() {
        #expect(dbfs(rms: [Float](repeating: 0, count: 100)) == -.infinity)
        let sine = (0..<4800).map { Float(sin(Double($0) * 2 * .pi / 48)) }
        #expect(abs(dbfs(rms: sine) - -3.01) < 0.05)
    }
}

@Suite struct DraftNoticeTests {
    @Test func whatTheSummaryPaneSays() {
        #expect(DraftNotice.for(hasSummary: true, writing: true, modelAvailable: true, paired: true) == nil)
        #expect(DraftNotice.for(hasSummary: false, writing: true, modelAvailable: true, paired: false) == .writing)
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: false, paired: true) == .computerWillWrite)
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: false, paired: false) == .needsAppleIntelligence)
        // the model is there but writing failed or didn't start: the computer still can
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: true, paired: true) == .computerWillWrite)
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: true, paired: false) == .notWritten)
        // the model is downloading: it writes them once it's ready
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: false, modelPreparing: true, paired: false) == .modelPreparing)
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: false, modelPreparing: true, paired: true) == .computerWillWrite)
    }
}

@Suite struct RecordingInProgressTests {
    @Test func aCrashedRecordingBecomesAMeeting() throws {
        let folder = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Yogurt test recordings")
        var p = RecordingInProgress(id: "rec-1", startedAt: t0, audioFile: "rec-1.m4a")
        p.myNotes = "budget"
        p.lines = [.init(startMs: 0, endMs: 1000, text: "Hello.")]
        let data = try JSONEncoder().encode(p)
        let back = try JSONDecoder().decode(RecordingInProgress.self, from: data)
        #expect(back == p)

        let rec = back.recording(in: folder, title: "Meeting at 3:40 PM", durationMs: 65_000)
        #expect(rec.id == "rec-1")
        #expect(rec.endedAt == t0.addingTimeInterval(65))
        #expect(rec.audioURL == folder.appendingPathComponent("rec-1.m4a"))
        #expect(rec.myNotes == "budget")
        #expect(rec.transcript.count == 1)
        #expect(rec.summary == nil && rec.uploadedAt == nil)
    }

    @Test func withoutAKnownLengthTheLastLineSetsTheEnd() {
        var p = RecordingInProgress(id: "r", startedAt: t0, audioFile: "r.m4a")
        p.lines = [.init(startMs: 0, endMs: 42_000, text: "x")]
        let rec = p.recording(in: URL(fileURLWithPath: "/tmp"), title: "t", durationMs: nil)
        #expect(rec.endedAt == t0.addingTimeInterval(42))
    }
}

@Suite struct PhoneDraftStoreTests {
    private func recording(summary: String?) -> LocalRecording {
        LocalRecording(id: "p1", title: "Meeting at 3:40 PM", startedAt: t0, endedAt: t0.addingTimeInterval(60), attendees: [],
                       audioURL: URL(fileURLWithPath: "/tmp/p1.m4a"), myNotes: "budget", transcript: [.init(startMs: 0, endMs: 900, text: "Hello.")],
                       summary: summary)
    }

    /// Uploaded within seconds on the same Wi-Fi, the computer's copy (still transcribing) lands before the phone's
    /// draft notes are written: they still show until the computer writes its own.
    @Test func draftNotesWrittenAfterTheComputerTookTheMeetingStillShow() throws {
        let store = try Store(url: tempStoreURL())
        try store.saveLocalRecording(recording(summary: nil))
        try store.apply(try changes("""
        [{"entity":"meeting","id":"p1","record":{"id":"p1","title":"Meeting at 3:40 PM","startedAt":1000,"endedAt":2000,"attendees":[]}},
         {"entity":"notes","id":"p1","record":{"meetingId":"p1","mine":"budget","summary":null}}]
        """), cursor: 1)
        try store.saveLocalRecording(recording(summary: "## Budget\n- Agreed"))
        #expect(store.notes("p1")?.summary == "## Budget\n- Agreed")
        #expect(store.notes("p1")?.summarySource == .phoneDraft)
        #expect(store.notes("p1")?.mine == "budget")

        // the computer's own notes replace the draft, and a late phone draft never comes back over them
        try store.apply(try changes("""
        [{"entity":"notes","id":"p1","record":{"meetingId":"p1","mine":"budget","summary":"## From the computer"}}]
        """), cursor: 2)
        try store.saveLocalRecording(recording(summary: "## Late draft"))
        #expect(store.notes("p1")?.summary == "## From the computer")
        #expect(store.notes("p1")?.summarySource == .desktop)
    }
}
