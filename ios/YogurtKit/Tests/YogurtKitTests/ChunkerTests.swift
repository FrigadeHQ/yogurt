import Foundation
import Testing
@testable import YogurtKit

private func seg(_ i: Int, _ text: String, speaker: String? = nil) -> Segment {
    Segment(index: i, startMs: i * 1000, endMs: i * 1000 + 900, speaker: speaker, text: text)
}

/// whitespace-insensitive, so a cut between words still counts as the same text
private func words(_ s: String) -> [Substring] { s.split(whereSeparator: \.isWhitespace) }

@Suite struct ChunkerTests {
    @Test func shortTranscriptIsOneChunk() {
        let segments = [seg(0, "We ship on Thursday."), seg(1, "Maya writes the post.")]
        #expect(Chunker.chunks(segments) == ["We ship on Thursday.\nMaya writes the post."])
    }

    @Test func nothingSaidIsNoChunks() {
        #expect(Chunker.chunks([]).isEmpty)
        #expect(Chunker.chunks([seg(0, "  "), seg(1, "\n")]).isEmpty)
    }

    @Test func splitsOnLineBoundariesUnderTheLimit() {
        let segments = (0..<200).map { seg($0, "Line \($0) about the launch plan and the budget for next quarter.") }
        let lines = segments.map(\.text)
        let chunks = Chunker.chunks(segments, maxChars: 500)
        #expect(chunks.count > 1)
        for c in chunks {
            #expect(c.count <= 500)
            // only whole lines
            for line in c.split(separator: "\n") { #expect(lines.contains(String(line))) }
        }
        // nothing dropped, nothing repeated, in order
        #expect(chunks.joined(separator: "\n") == lines.joined(separator: "\n"))
    }

    @Test func aLongLineIsCutBetweenSentencesThenWords() {
        let sentence = "This is one sentence about the roadmap. "
        let long = String(repeating: sentence, count: 40).trimmingCharacters(in: .whitespaces)
        let chunks = Chunker.chunks([seg(0, "Hello."), seg(1, long), seg(2, "Bye.")], maxChars: 300)
        for c in chunks { #expect(c.count <= 300) }
        #expect(words(chunks.joined(separator: " ")) == words("Hello. \(long) Bye."))
        // cut after a full stop, not mid-sentence
        #expect(chunks.dropLast().allSatisfy { $0.hasSuffix(".") })
    }

    @Test func textWithNoSpacesIsCutHardAndKeptWhole() {
        let blob = String(repeating: "あいうえお", count: 100)
        let chunks = Chunker.chunks([seg(0, blob)], maxChars: 120)
        for c in chunks { #expect(c.count <= 120) }
        #expect(chunks.joined() == blob)
    }

    @Test func speakersAreNamedOnTheirLines() {
        let chunks = Chunker.chunks([seg(0, "Hi.", speaker: "me"), seg(1, "Hello.", speaker: "Leo"), seg(2, "Hey.")])
        #expect(chunks == ["You: Hi.\nLeo: Hello.\nHey."])
    }

    @Test func plainTextChunksTheSameWay() {
        let text = (0..<50).map { "### Topic \($0)\n- a point about it" }.joined(separator: "\n")
        let chunks = Chunker.chunks(text: text, maxChars: 200)
        for c in chunks { #expect(c.count <= 200) }
        #expect(chunks.joined(separator: "\n") == text)
    }
}
