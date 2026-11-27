import Foundation

/// Ask's text, beside the screen so it doesn't collide with other work in Strings.swift.
extension S {
    static let ask = String(localized: "Ask")
    static let askTitle = String(localized: "Ask about your meetings")
    static let askPrompt = String(localized: "Ask about your meetings")
    static let askAnything = String(localized: "Ask anything about this meeting")
    static let askSend = String(localized: "Ask")
    static let askThisMeeting = String(localized: "This meeting")
    static let askStarter1 = String(localized: "What are my next steps this week?")
    static let askStarter2 = String(localized: "What did we decide last week?")
    static let askStarter3 = String(localized: "Catch me up on yesterday")
    static let askMeetingStarter1 = String(localized: "What was decided?")
    static let askMeetingStarter2 = String(localized: "What are my next steps?")
    static let askMeetingStarter3 = String(localized: "What questions are still open?")
    static let askReading = String(localized: "Reading your meetings…")
    static let askByComputer = String(localized: "Answered by your computer")
    static let askByPhone = String(localized: "Answered on this iPhone")
    static let askFailed = String(localized: "Yogurt couldn't answer that.")
    static let askNeedsModel = String(localized: "Ask needs Apple Intelligence on this iPhone, or your computer nearby.")
    static let askNeedsModelAlone = String(localized: "Ask needs Apple Intelligence on this iPhone.")
    static let askSearchInstead = String(localized: "You can still search your meetings.")
    static let searchMeetings = String(localized: "Search your meetings")
    static let askSources = String(localized: "Sources")
    static let newChat = String(localized: "New chat")
    static let openInTranscript = String(localized: "Open in transcript")
    static let notesSource = String(localized: "The meeting notes")
    static let untitled = String(localized: "Untitled")
    static func askIn(_ scope: String) -> String { String(localized: "In \(scope)") }
    static func sourceAt(_ title: String, _ moment: String) -> String { String(localized: "\(title) · \(moment)") }
}
