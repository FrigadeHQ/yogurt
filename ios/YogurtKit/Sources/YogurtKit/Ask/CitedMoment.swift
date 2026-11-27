import Foundation

/// Where in the transcript an answer's claim was said, for a source that is a meeting's notes: the notes have no
/// moment of their own, so tapping one opens the transcript at the line that says the same thing.
public enum CitedMoment {
    /// The answer's sentences that cite [n], without their citations or bold marks.
    public static func claim(for n: Int, in answer: String) -> String {
        let lines = answer.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces).replacing(/^([-*]|\d+\.)\s+/, with: "") }
        // a sentence ends at . ! or ? and the space after it
        let sentences: [String] = lines.flatMap { $0.replacing(/([.!?])\s+/) { "\($0.output.1)\n" }.components(separatedBy: "\n") }
        return sentences.filter { citedNumbers($0).contains(n) }.map(plain).filter { !$0.isEmpty }.joined(separator: " ")
    }

    private static func plain(_ sentence: String) -> String {
        sentence.replacing(/\[\d+(?:\s*,\s*\d+)*\]/, with: "").replacingOccurrences(of: "**", with: "")
            .replacing(/\s+([.,;:!?])/) { String($0.output.1) }
            .trimmingCharacters(in: .whitespaces)
    }

    /// The start of the line sharing the most of the claim's words, its neighbours breaking ties. Nil when no line
    /// and its neighbours share at least two of them: a guess that far off would be worse than the notes.
    public static func atMs(claim: String, segments: [Segment]) -> Int? {
        let terms = LocalAsk.searchTerms(claim)
        guard terms.count >= 2 else { return nil }
        let found = segments.map { s in Set(terms.filter { s.text.lowercased().contains($0) }) }
        var best: (i: Int, score: Double)?
        for i in found.indices where !found[i].isEmpty {
            let around = (i > 0 ? found[i - 1] : []).union(i + 1 < found.count ? found[i + 1] : []).subtracting(found[i])
            guard found[i].count + around.count >= 2 else { continue }
            let score = Double(found[i].count) + 0.5 * Double(around.count)
            if score > best?.score ?? 0 { best = (i, score) }
        }
        return best.map { segments[$0.i].startMs }
    }
}
