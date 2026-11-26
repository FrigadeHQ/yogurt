import SwiftUI
import YogurtKit

struct RoomTranscriptBubble: View {
    let bubble: RoomBubble
    var marked = false
    var play: (() -> Void)?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if bubble.showsTime {
                Text(Format.offset(bubble.startMs))
                    .font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
                    .accessibilityHidden(true)
            }
            if let play {
                Button(action: play) {
                    contents.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(spoken)
            } else {
                contents
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(spoken)
            }
        }
        .frame(maxWidth: typeSize.isAccessibilitySize ? .infinity : 560, alignment: .leading)
        .padding(.trailing, typeSize.isAccessibilitySize ? 0 : 48)
        .padding(.top, bubble.showsTime && bubble.id != 0 ? 3 : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var spoken: Text {
        let time = Duration.seconds(max(0, bubble.startMs) / 1000).formatted(.units(width: .wide))
        let words = [bubble.text, bubble.liveText].filter { !$0.isEmpty }.joined(separator: " ")
        return Text(verbatim: "\(time), \(words)")
    }

    private var contents: some View {
        Group {
            if bubble.liveText.isEmpty {
                Text(verbatim: bubble.text).textSelection(.enabled)
            } else {
                LiveBubbleText(settled: bubble.text, partial: bubble.liveText)
            }
        }
        .font(.body)
        .foregroundStyle(Theme.ink)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 10).padding(.vertical, 5)
        .frame(minWidth: 44, minHeight: 44, alignment: .leading)
        .background(marked ? Theme.accentSoft : Theme.control, in: RoundedRectangle(cornerRadius: 9))
    }
}

private struct LiveBubbleText: View {
    let settled: String
    let partial: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var arrivals = LiveWordArrivals()

    var body: some View {
        let content = inlineText
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { tick in
            content.textRenderer(LiveInk(date: tick.date, still: reduceMotion))
        }
        .onChange(of: partial, initial: true) { _, words in arrivals.update(words, at: .now) }
    }

    private var inlineText: Text {
        var result = Text(verbatim: settled.isEmpty ? "" : settled + " ")
        for word in arrivals.words {
            let fragment = Text(verbatim: word.text).foregroundStyle(Theme.muted).customAttribute(Arrival(date: word.arrived))
            result = Text("\(result)\(fragment)")
        }
        let dots = Text(Image(systemName: "ellipsis")).customAttribute(Dots())
        return Text("\(result) \(dots)")
    }
}

private struct Arrival: TextAttribute { let date: Date }
private struct Dots: TextAttribute {}

/// The inline symbol reserves space for all three dots, including when the words wrap.
private struct LiveInk: TextRenderer {
    let date: Date
    let still: Bool
    private let fade = UnitCurve.bezier(startControlPoint: .init(x: 0.23, y: 1), endControlPoint: .init(x: 0.32, y: 1))

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            for run in line {
                if run[Dots.self] != nil {
                    let rect = run.typographicBounds.rect
                    let diameter = min(4, rect.width / 4.5)
                    for i in 0..<3 {
                        let phase = (date.timeIntervalSinceReferenceDate - Double(i) * 0.2).truncatingRemainder(dividingBy: 1.2)
                        let pulse = max(0, 1 - abs(phase - 0.48) / 0.48)
                        let opacity = still ? 0.6 : 0.3 + 0.7 * UnitCurve.easeInOut.value(at: pulse)
                        let x = rect.midX + CGFloat(i - 1) * 1.75 * diameter
                        let dot = CGRect(x: x - diameter / 2, y: rect.midY - diameter / 2, width: diameter, height: diameter)
                        context.fill(Path(ellipseIn: dot), with: .color(Theme.muted.opacity(opacity)))
                    }
                } else {
                    var ink = context
                    if !still, let arrival = run[Arrival.self] {
                        let progress = min(1, max(0, date.timeIntervalSince(arrival.date) / 0.18))
                        ink.opacity = fade.value(at: progress)
                    }
                    ink.draw(run)
                }
            }
        }
    }
}
