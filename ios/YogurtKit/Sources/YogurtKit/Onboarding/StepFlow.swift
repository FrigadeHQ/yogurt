/// The first run's steps in order. A step moves on only while it is the one showing, so two "done"s for the same
/// step (the permission prompt's return and its button) move one step, never two.
public struct StepFlow<Step: Hashable & Sendable>: Sendable {
    public let steps: [Step]
    public private(set) var index: Int
    public private(set) var finished = false

    public init(_ steps: [Step], startingAt start: Step? = nil) {
        self.steps = steps
        index = start.flatMap { steps.firstIndex(of: $0) } ?? 0
    }

    public var count: Int { steps.count }
    /// nil once finished
    public var current: Step? { finished || !steps.indices.contains(index) ? nil : steps[index] }

    /// True when it moved: on to the next step, or finished after the last one.
    @discardableResult
    public mutating func advance(from step: Step) -> Bool {
        guard current == step else { return false }
        if index + 1 < steps.count { index += 1 } else { finished = true }
        return true
    }
}
