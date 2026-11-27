import Foundation
import Testing
@testable import YogurtKit

private func line(_ i: Int, _ text: String) -> Segment {
    Segment(index: i, startMs: i * 30_000, endMs: i * 30_000 + 25_000, speaker: nil, text: text)
}

@Suite struct CitedMomentTests {
    @Test func theClaimIsTheSentencesThatCiteTheNumber() {
        let answer = "Acme pays **40 dollars a seat** [1]. Two engineers start in March [2].\n- The renewal is due in May [1, 2]"
        #expect(CitedMoment.claim(for: 1, in: answer) == "Acme pays 40 dollars a seat. The renewal is due in May")
        #expect(CitedMoment.claim(for: 2, in: answer) == "Two engineers start in March. The renewal is due in May")
        #expect(CitedMoment.claim(for: 3, in: answer) == "")
    }

    @Test func findsWhereTheClaimWasSaid() {
        let lines = [
            line(0, "Hello everyone, thanks for joining."),
            line(1, "Let's talk about the hiring plan first."),
            line(2, "Acme asked for a discount on the renewal."),
            line(3, "We agreed on forty dollars a seat for Acme."),
            line(4, "Great, see you next week."),
        ]
        #expect(CitedMoment.atMs(claim: "Acme pays forty dollars a seat for the renewal", segments: lines) == 90_000)
    }

    @Test func nothingWhenTheTranscriptDoesNotSayIt() {
        let lines = [line(0, "Hello everyone."), line(1, "The tacos were great.")]
        #expect(CitedMoment.atMs(claim: "Acme pays forty dollars a seat", segments: lines) == nil)
        #expect(CitedMoment.atMs(claim: "Acme pays forty dollars a seat", segments: []) == nil)
        #expect(CitedMoment.atMs(claim: "", segments: lines) == nil)
    }

    @Test func oneSharedWordIsNotEnough() {
        let lines = [line(0, "Acme called."), line(1, "Lunch was late.")]
        #expect(CitedMoment.atMs(claim: "Acme pays forty dollars a seat", segments: lines) == nil)
    }
}
