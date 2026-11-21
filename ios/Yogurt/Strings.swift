import Foundation

/// Every piece of text a person sees, in one place so translation is easy later. Plain, friendly, no jargon.
/// (The connection status labels live with ConnectionStatus in YogurtKit, where they are tested.)
enum S {
    // Pairing
    static let pairTitle = "Pair with your computer"
    static let pairIntro = "Yogurt on your iPhone carries your meetings from Yogurt on your computer, so you can read and search them anywhere."
    static let pairStep1 = "Open Yogurt on your computer."
    static let pairStep2 = "Go to Settings, then Phone, and click Pair a phone."
    static let pairStep3 = "Keep this iPhone on the same Wi-Fi."
    static let pairLooking = "Looking for your computer on this Wi-Fi…"
    static let pairFound = "Pick your computer"
    static let pairReady = "Ready to pair"
    static let pairNotReady = "Not showing a pairing code yet"
    static func codeTitle(_ name: String) -> String { "Type the code shown on \(name)" }
    static let codeHelp = "It's the 6-digit code in Yogurt's Settings, under Phone."
    static let codeField = "Pairing code"
    static let pairing = "Pairing…"
    static let pairFailed = "That didn't work. Check the code on your computer and try again."
    static let pairExpired = "Pairing isn't open on your computer any more. Click Pair a phone there, then type the new code."
    static let pairTooMany = "Too many wrong codes. Type the new code your computer shows."
    static let pairUnreachable = "Couldn't reach your computer. Check that both are on the same Wi-Fi and try again."
    static let localNetworkNote = "Your iPhone will ask to find devices on your network. Tap Allow so Yogurt can reach your computer."
    static let otherComputer = "Pick another computer"
    static let privacyNote = "Your iPhone talks to your computer only on the same Wi-Fi. Nothing goes through the internet."
    static let trySample = "Try with sample meetings"

    // Home
    static let yourMeetings = "Your meetings"
    static let allMeetings = "All meetings"
    static let record = "Record"
    static let emptyTitle = "Your meetings will show up here"
    static let emptyBody = "They come over from your computer when both are on the same Wi-Fi."
    static let emptyFolder = "No meetings in this folder yet"
    static let search = "Search"
    static let settings = "Settings"
    static let personalNotes = "Personal notes"
    static let today = "Today"
    static let yesterday = "Yesterday"
    static func minutes(_ n: Int) -> String { "\(n) min" }
    static func andMore(_ names: String, _ more: Int) -> String { "\(names) + \(more)" }
    static let recordingSoonTitle = "Recording is on its way"
    static let recordingSoonBody = "Soon you can record meetings right on this iPhone. For now, record on your computer and they'll show up here."
    static let ok = "OK"

    // Note
    static let summary = "Summary"
    static let myNotes = "My notes"
    static let transcript = "Transcript"
    static let noSummary = "The summary isn't written yet."
    static let noSummaryBody = "Your computer writes it after the meeting. It shows up here once both are on the same Wi-Fi."
    static let draftSummary = "Draft from this iPhone. Your computer will write the final summary."
    static let myNotesPlaceholder = "Type your notes here."
    static let savedHere = "Saved on this iPhone"
    static let saving = "Saving…"
    static let notSaved = "Couldn't save your notes. Try again."
    static let noTranscript = "There's no transcript for this meeting."
    static let me = "Me"
    static let them = "Them"
    static let more = "More"
    static let rename = "Rename"
    static let renameTitle = "Rename meeting"
    static let title = "Title"
    static let save = "Save"
    static let cancel = "Cancel"
    static let folders = "Folders"
    static let addToFolder = "Add to folder"
    static let noFolders = "No folders yet. Make them on your computer."
    static let moveToTrash = "Move to Trash"
    static let inTrash = "This meeting is in the Trash."
    static let restore = "Restore"
    static let changeQueued = "Your change goes to your computer next time they connect."
    static let notFound = "This meeting isn't on this iPhone any more."

    // Search
    static let searchPrompt = "Search your meetings"
    static let searchHint = "Search titles, notes and transcripts."
    static func noResults(_ q: String) -> String { "Nothing matches “\(q)”." }
    static func foundIn(_ field: String) -> String { "In \(field)" }
    static let fieldTitle = "the title"
    static let fieldMine = "My notes"
    static let fieldSummary = "the summary"
    static let fieldTranscript = "the transcript"

    // Settings
    static let done = "Done"
    static let computer = "Computer"
    static let notPaired = "Not paired"
    static let pairComputer = "Pair with a computer"
    static let syncNow = "Sync now"
    static let unpair = "Unpair"
    static func unpairTitle(_ name: String) -> String { "Unpair from \(name)?" }
    static let unpairBody = "Meetings from your computer are removed from this iPhone. They stay on your computer, and you can pair again any time."
    static let privacy = "Privacy"
    static let faceIDLock = "Lock with Face ID"
    static let faceIDFooter = "Yogurt asks for Face ID when you open it."
    static let storage = "Storage"
    static let meetingsOnPhone = "Meetings on this iPhone"
    static let spaceUsed = "Space used"
    static let sampleOn = "You're looking at sample meetings. Unpair to remove them."

    // Lock
    static let locked = "Yogurt is locked"
    static let unlock = "Unlock"
    static let unlockReason = "Unlock to see your meetings."

    // Errors
    static let storeFailed = "Yogurt couldn't open its storage on this iPhone. Restart your iPhone and try again."
}
