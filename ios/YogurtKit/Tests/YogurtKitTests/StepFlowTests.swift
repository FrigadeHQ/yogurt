import Testing
@testable import YogurtKit

@Suite struct StepFlowTests {
    @Test func aStepAdvancesOnceHoweverManyTimesItIsFinished() {
        // the permission prompt makes the app inactive then active: the return and the button both say "done"
        var flow = StepFlow(["welcome", "mic", "speech", "ready"])
        let moved1 = flow.advance(from: "welcome"); #expect(moved1 == true)
        #expect(flow.current == "mic")
        let moved2 = flow.advance(from: "mic"); #expect(moved2 == true)
        let moved3 = flow.advance(from: "mic"); #expect(moved3 == false)
        #expect(flow.current == "speech")
    }

    @Test func theLastStepFinishesTheFlow() {
        var flow = StepFlow(["welcome", "ready"])
        let moved4 = flow.advance(from: "welcome"); #expect(moved4 == true)
        #expect(!flow.finished)
        let moved5 = flow.advance(from: "ready"); #expect(moved5 == true)
        #expect(flow.finished)
        #expect(flow.current == nil)
        let moved6 = flow.advance(from: "ready"); #expect(moved6 == false)
        #expect(flow.index == 1)
    }

    @Test func itCanStartPartWay() {
        let flow = StepFlow(["welcome", "mic", "ready"], startingAt: "mic")
        #expect(flow.current == "mic")
        #expect(flow.index == 1)
        #expect(flow.count == 3)
    }
}
