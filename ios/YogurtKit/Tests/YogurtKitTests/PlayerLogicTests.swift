import Foundation
import Testing
@testable import YogurtKit

@Suite struct PlayerLogicTests {
    @Test func theSourceIsThePhonesOwnRecordingThenTheCacheThenTheComputer() {
        #expect(PlayerLogic.source(phoneFile: true, cached: true, connected: true) == .phone)
        #expect(PlayerLogic.source(phoneFile: false, cached: true, connected: false) == .cached)
        #expect(PlayerLogic.source(phoneFile: false, cached: false, connected: true) == .computer)
        #expect(PlayerLogic.source(phoneFile: false, cached: false, connected: false) == .none)
    }

    @Test func timeReadsAsMinutesAndSecondsThenHours() {
        #expect(PlayerLogic.clock(ms: 0) == "0:00")
        #expect(PlayerLogic.clock(ms: 185_900) == "3:05")
        #expect(PlayerLogic.clock(ms: 3_723_000) == "1:02:03")
        #expect(PlayerLogic.clock(ms: -500) == "0:00")
    }

    @Test func aLineSeeksOneSecondBeforeItsStartLikeDesktop() {
        #expect(PlayerLogic.seekMs(forLineAt: 65_000) == 64_000)
        #expect(PlayerLogic.seekMs(forLineAt: 400) == 0)
    }

    @Test func theScrubberMapsBothWaysAndStaysInRange() {
        #expect(PlayerLogic.fraction(ms: 30_000, duration: 120_000) == 0.25)
        #expect(PlayerLogic.fraction(ms: 5, duration: 0) == 0)
        #expect(PlayerLogic.fraction(ms: 500_000, duration: 120_000) == 1)
        #expect(PlayerLogic.ms(atFraction: 0.5, duration: 120_000) == 60_000)
        #expect(PlayerLogic.ms(atFraction: 2, duration: 120_000) == 120_000)
        #expect(PlayerLogic.ms(atFraction: -1, duration: 120_000) == 0)
    }

    @Test func speedCyclesThroughOneOnePointFiveAndTwo() {
        #expect(PlayerLogic.nextRate(1) == 1.5)
        #expect(PlayerLogic.nextRate(1.5) == 2)
        #expect(PlayerLogic.nextRate(2) == 1)
        #expect(PlayerLogic.nextRate(0.7) == 1)
        #expect(PlayerLogic.rateLabel(1) == "1×")
        #expect(PlayerLogic.rateLabel(1.5) == "1.5×")
    }

    @Test func theLinePlayingIsTheLastOneStartedByNow() {
        let starts = [0, 4_000, 9_000]
        #expect(PlayerLogic.line(at: 0, starts: starts) == 0)
        #expect(PlayerLogic.line(at: 8_999, starts: starts) == 1)
        #expect(PlayerLogic.line(at: 50_000, starts: starts) == 2)
        #expect(PlayerLogic.line(at: 100, starts: []) == nil)
        // before the first line starts, the first is next
        #expect(PlayerLogic.line(at: 100, starts: [500, 900]) == 0)
    }

    @Test func onlyKindsTheiPhonePlaysAreAccepted() {
        for ok in ["m4a", "WAV", "mp3", "mp4"] { #expect(PlayerLogic.canPlay(ext: ok)) }
        for no in ["ogg", "opus", "", "webm"] { #expect(!PlayerLogic.canPlay(ext: no)) }
    }
}
