import Foundation

/// Every piece of text a person sees, in one place so translation is easy later. Plain, friendly, no jargon.
/// (The connection status labels live with ConnectionStatus in YogurtKit, where they are tested.)
enum S {
    // Onboarding (the desktop's first run, in the same voice: one idea per screen, each can wait)
    static let getStarted = "Get started"
    static let welcomeTitle = "Take note."
    static let welcomeText = "Private AI meeting notes that stay on your iPhone. No bot joins your meetings."
    static let micTitle = "Microphone"
    static let micText = "Allow microphone access so Yogurt can record your meetings."
    static let speechTitle = "Speech recognition"
    static let speechText = "Allow speech recognition so Yogurt can write the transcript right on this iPhone."
    static let allow = "Allow"
    static let notNow = "Not now"
    static let openSettings = "Open Settings"
    static let continueOn = "Continue"
    static let turnedOffBefore = "This was turned off before, so only Settings can turn it on."
    static let computerTitle = "Already use Yogurt on your computer?"
    static let computerText = "Connect them to see your computer's meetings here, and send what you record on your iPhone back."
    static let connect = "Connect"
    static let allSet = "All set"
    static func connectedTo(_ name: String) -> String { "Connected to \(name). You can change this any time in Settings." }
    static let readyTitle = "You're ready"
    static let readyText = "Tap Record when a meeting starts. Yogurt writes the notes on this iPhone."
    static func readyTextPaired(_ name: String) -> String { "Your meetings from \(name) are on their way. Tap Record to take notes anywhere." }
    static let startUsing = "Start using Yogurt"
    static func stepOf(_ n: Int, _ total: Int) -> String { "Step \(n) of \(total)" }

    // Art (made-up examples in the onboarding pictures)
    static let artMeeting = "Design review"
    static let artWhen = "Today · 10:00"
    static let artPoint1 = "Ship the beta on Thursday"
    static let artPoint2 = "Maya writes the post"
    static let artOnPhone = "On this iPhone"
    static let artYou = "You and the room"
    static let artLine1 = "I'll send a draft by Friday."
    static let artLine2 = "Great, I'll review it that afternoon."
    static let artWritten = "Written on this iPhone"
    static let artSynced = "Same Wi-Fi"
    static let artMeeting2 = "Weekly planning"
    static let artWhen2 = "Yesterday · 9:30"

    // Connecting to a computer
    static let pairTitle = "Connect to your computer"
    static let pairIntro = "See the meetings from Yogurt on your computer here too, and send what you record on your iPhone back."
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
    static let localNetworkDenied = "Allow Local Network for Yogurt in Settings to reach your computer."
    static let otherComputer = "Pick another computer"
    static let privacyNote = "Your iPhone talks to your computer only on the same Wi-Fi. Nothing goes through the internet."
    static let trySample = "Try with sample meetings"

    // Home
    static let yourMeetings = "Your meetings"
    static let allMeetings = "All meetings"
    static let record = "Record"
    static let emptyTitle = "Your meetings will show up here"
    static let emptyBody = "They come over from your computer when both are on the same Wi-Fi."
    static let emptyBodyAlone = "Tap Record when a meeting starts. Yogurt writes the notes on this iPhone."
    static let connectHint = "Use Yogurt on your computer too?"
    static let hide = "Hide"
    static let emptyFolder = "No meetings in this folder yet"
    static let search = "Search"
    static let settings = "Settings"
    static let personalNotes = "Personal notes"
    static let today = "Today"
    static let yesterday = "Yesterday"
    static func minutes(_ n: Int) -> String { "\(n) min" }
    static func andMore(_ names: String, _ more: Int) -> String { "\(names) + \(more)" }
    static let recordingSoonTitle = "Recording is on its way"
    static let recordingSoonBody = "Soon you can record meetings right on this iPhone."
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
    static let onPhoneOnly = "On this iPhone only"
    static let connectFooter = "Connect to see your computer's meetings here too. Everything still works without it."
    static let connectComputer = "Connect to your computer"
    static let syncNow = "Sync now"
    static let unpair = "Unpair"
    static func unpairTitle(_ name: String) -> String { "Unpair from \(name)?" }
    static let unpairBody = "Meetings from your computer are removed from this iPhone. They stay on your computer, and you can connect again any time."
    static let privacy = "Privacy"
    static let faceIDLock = "Lock with Face ID"
    static let faceIDFooter = "Yogurt asks for Face ID when you open it."
    static let faceIDNeedsPasscode = "Set a passcode on this iPhone to use this."
    static let permissions = "Permissions"
    static let permissionsFooter = "Yogurt uses these to record and transcribe on this iPhone."
    static let accessOn = "On"
    static let accessOff = "Off"
    static let accessNotAsked = "Not asked yet"
    static let storage = "Storage"
    static let meetingsOnPhone = "Meetings on this iPhone"
    static let spaceUsed = "Space used"
    static let sampleOn = "You're looking at sample meetings. Unpair to remove them."
    static func codeDigits(_ n: Int) -> String { "\(n) of 6 digits" }

    // Lock
    static let locked = "Yogurt is locked"
    static let unlock = "Unlock"
    static let unlockReason = "Unlock to see your meetings."
    static let unlockFailed = "Couldn't check it's you. Try again."

    // Errors
    static let storeFailed = "Yogurt couldn't open its storage on this iPhone. Restart your iPhone and try again."
}
