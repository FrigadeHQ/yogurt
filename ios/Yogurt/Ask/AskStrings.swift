import Foundation

/// Ask's text, beside the screen so it doesn't collide with other work in Strings.swift.
extension S {
    static let ask = "Ask"
    static let askTitle = "Ask about your meetings"
    static let askPrompt = "Ask about your meetings"
    static let askAnything = "Ask anything about this meeting"
    static let askSend = "Ask"
    static let askThisMeeting = "This meeting"
    static let askStarter1 = "What are my next steps this week?"
    static let askStarter2 = "What did we decide last week?"
    static let askStarter3 = "Catch me up on yesterday"
    static let askMeetingStarter1 = "What was decided?"
    static let askMeetingStarter2 = "What are my next steps?"
    static let askMeetingStarter3 = "What questions are still open?"
    static let askReading = "Reading your meetings…"
    static let askByComputer = "Answered by your computer"
    static let askByPhone = "Answered on this iPhone"
    static let askFailed = "Yogurt couldn't answer that."
    static let askNeedsModel = "Ask needs Apple Intelligence on this iPhone, or your computer nearby."
    static let askSearchInstead = "You can still search your meetings."
    static let searchMeetings = "Search your meetings"
    static let askSources = "Sources"
    static let openNote = "Open note"
    static let openInTranscript = "Open in transcript"
    static let notesSource = "The meeting notes"
    static let untitled = "Untitled"
    static func askIn(_ scope: String) -> String { "In \(scope)" }
    static func sourceAt(_ title: String, _ moment: String) -> String { "\(title) · \(moment)" }
}
