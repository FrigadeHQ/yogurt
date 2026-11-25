import Foundation

/// Every piece of text a person sees, in one place. Plain, friendly, no jargon. The English text is the key; each
/// language's wording is in Localizable.xcstrings (the connection status labels live with ConnectionStatus in YogurtKit,
/// and are looked up in the same catalog).
enum S {
    // Onboarding (the desktop's first run, in the same voice: one idea per screen, each can wait)
    static let getStarted = String(localized: "Get started")
    static let welcomeTitle = String(localized: "Take note.")
    static let welcomeText = String(localized: "Private AI meeting notes that stay on your iPhone. No bot joins your meetings.")
    static let micTitle = String(localized: "Microphone")
    static let micText = String(localized: "Allow microphone access so Yogurt can record your meetings.")
    static let speechTitle = String(localized: "Speech recognition")
    static let speechText = String(localized: "Allow speech recognition so Yogurt can write the transcript right on this iPhone.")
    static let allow = String(localized: "Allow")
    static let notNow = String(localized: "Not now")
    static let openSettings = String(localized: "Open Settings")
    static let continueOn = String(localized: "Continue")
    static let restricted = String(localized: "This is turned off by a Screen Time or device setting, so Yogurt can't ask for it.")
    static let accessRestricted = String(localized: "Not allowed on this iPhone")
    static let turnedOffBefore = String(localized: "This was turned off before, so only Settings can turn it on.")
    static let computerTitle = String(localized: "Already use Yogurt on your computer?")
    static let computerText = String(localized: "Connect them to see your computer's meetings here, and send what you record on your iPhone back.")
    static let connect = String(localized: "Connect")
    static let allSet = String(localized: "All set")
    static func connectedTo(_ name: String) -> String { String(localized: "Connected to \(name). You can change this any time in Settings.") }
    static let readyTitle = String(localized: "You're ready")
    static let readyText = String(localized: "Tap Record when a meeting starts. Yogurt writes the notes on this iPhone.")
    static func readyTextPaired(_ name: String) -> String { String(localized: "Your meetings from \(name) are on their way. Tap Record to take notes anywhere.") }
    static let startUsing = String(localized: "Start using Yogurt")
    static func stepOf(_ n: Int, _ total: Int) -> String { String(localized: "Step \(n) of \(total)") }

    // Art (made-up examples in the onboarding pictures)
    static let artMeeting = String(localized: "Design review")
    static let artWhen = String(localized: "Today · 10:00")
    static let artPoint1 = String(localized: "Ship the beta on Thursday")
    static let artPoint2 = String(localized: "Maya writes the post")
    static let artOnPhone = String(localized: "On this iPhone")
    static let artYou = String(localized: "You and the room")
    static let artLine1 = String(localized: "I'll send a draft by Friday.")
    static let artLine2 = String(localized: "Great, I'll review it that afternoon.")
    static let artWritten = String(localized: "Written on this iPhone")
    static let artMeeting2 = String(localized: "Weekly planning")
    static let artWhen2 = String(localized: "Yesterday · 9:30")

    // Connecting to a computer
    static let pairTitle = String(localized: "Connect to your computer")
    static let pairIntro = String(localized: "See the meetings from Yogurt on your computer here too, and send what you record on your iPhone back.")
    static let pairStep1 = String(localized: "Open Yogurt on your computer.")
    static let pairStep2 = String(localized: "Go to Settings, then Phone, and click Pair a phone.")
    static let pairStep3 = String(localized: "Keep this iPhone on the same Wi-Fi.")
    static let pairLooking = String(localized: "Looking for your computer on this Wi-Fi…")
    static let pairFound = String(localized: "Pick your computer")
    static let pairReady = String(localized: "Ready to pair")
    static let pairNotReady = String(localized: "Not showing a pairing code yet")
    static func codeTitle(_ name: String) -> String {
        name.isEmpty ? String(localized: "Type the code shown on your computer") : String(localized: "Type the code shown on \(name)")
    }
    /// a computer on the Wi-Fi before pairing: its advert carries no name
    static let unnamedComputer = String(localized: "Yogurt on this Wi-Fi")
    static func computerName(_ name: String) -> String { name.isEmpty ? unnamedComputer : name }
    static let codeHelp = String(localized: "It's the 6-digit code in Yogurt's Settings, under Phone.")
    static let codeField = String(localized: "Pairing code")
    static let pairing = String(localized: "Pairing…")
    static let pairFailed = String(localized: "That didn't work. Check the code on your computer and try again.")
    static let pairExpired = String(localized: "Pairing isn't open on your computer any more. Click Pair a phone there, then type the new code.")
    static let pairTooMany = String(localized: "Too many wrong codes. Type the new code your computer shows.")
    static let pairUnreachable = String(localized: "Couldn't reach your computer. Check that both are on the same Wi-Fi and try again.")
    static let localNetworkNote = String(localized: "Your iPhone will ask to find devices on your network. Tap Allow so Yogurt can reach your computer.")
    static let localNetworkDenied = String(localized: "Allow Local Network for Yogurt in Settings to reach your computer.")
    static let otherComputer = String(localized: "Pick another computer")
    static let privacyNote = String(localized: "Your iPhone talks to your computer only on the same Wi-Fi. Nothing goes through the internet.")
    static let trySample = String(localized: "Try with sample meetings")

    // Home
    static let meetings = String(localized: "Meetings")
    static let allMeetings = String(localized: "All meetings")
    static let record = String(localized: "Record")
    static let emptyTitle = String(localized: "Your meetings will show up here")
    static let emptyBody = String(localized: "They come over from your computer when both are on the same Wi-Fi.")
    static let emptyBodyAlone = String(localized: "Tap Record when a meeting starts. Yogurt writes the notes on this iPhone.")
    static let emptyFolder = String(localized: "No meetings in this folder yet")
    static let search = String(localized: "Search")
    static let settings = String(localized: "Settings")
    static let personalNotes = String(localized: "Personal notes")
    static let today = String(localized: "Today")
    static let yesterday = String(localized: "Yesterday")
    static func minutes(_ n: Int) -> String { String(localized: "\(n) min") }
    static func andMore(_ names: String, _ more: Int) -> String { String(localized: "\(names) + \(more)") }

    // Note
    static let summary = String(localized: "Summary")
    static let myNotes = String(localized: "My notes")
    static let transcript = String(localized: "Transcript")
    static let noSummary = String(localized: "The summary isn't written yet.")
    static let noSummaryBody = String(localized: "Your computer writes it after the meeting. It shows up here once both are on the same Wi-Fi.")
    static let draftSummary = String(localized: "Draft from this iPhone. Your computer will write the final summary.")
    static let writtenHere = String(localized: "Written on this iPhone")
    static let myNotesPlaceholder = String(localized: "Type your notes here.")
    static let savedHere = String(localized: "Saved on this iPhone")
    static let saving = String(localized: "Saving…")
    static let notSaved = String(localized: "Couldn't save your notes. Try again.")
    static let noTranscript = String(localized: "There's no transcript for this meeting.")
    static let me = String(localized: "Me")
    static let them = String(localized: "Them")
    static let more = String(localized: "More")
    static let audioNearby = String(localized: "Audio plays when your computer is nearby.")
    static let audioDownloading = String(localized: "Downloading audio…")
    static let audioNone = String(localized: "There's no audio for this meeting.")
    static let audioCantPlay = String(localized: "This recording is in a format the iPhone can't play.")
    static let audioNotLoaded = String(localized: "Couldn't get the audio. Try again.")
    // Share, from the Note's menu: the files say what desktop's Save Markdown says
    static let shareSummary = String(localized: "Share summary")
    static let shareTranscript = String(localized: "Share transcript")
    static let shareAudio = String(localized: "Share audio")
    static let nothingToShare = String(localized: "Nothing to share yet")
    static let audioShareNearby = String(localized: "Audio can be shared when your computer is nearby.")
    static let audioPreparing = String(localized: "Getting the audio ready…")
    static let shareFailed = String(localized: "Couldn't share. Try again.")
    static let you = String(localized: "You")
    static let meeting = String(localized: "Meeting")
    static func with(_ names: String) -> String { String(localized: "With: \(names)") }
    static func recordedWith(_ app: String) -> String { String(localized: "Recorded with \(app)") }
    static let play = String(localized: "Play")
    static let playbackSpeed = String(localized: "Playback speed")
    static let position = String(localized: "Position")
    static let rename = String(localized: "Rename")
    static let renameTitle = String(localized: "Rename meeting")
    static let title = String(localized: "Title")
    static let save = String(localized: "Save")
    static let cancel = String(localized: "Cancel")
    static let addToFolder = String(localized: "Add to folder")
    static let noFolders = String(localized: "No folders yet. Make them on your computer.")
    static let moveToTrash = String(localized: "Move to Trash")
    static let inTrash = String(localized: "This meeting is in the Trash.")
    static let restore = String(localized: "Restore")
    static let changeQueued = String(localized: "Your change goes to your computer next time they connect.")
    static let notFound = String(localized: "This meeting isn't on this iPhone any more.")

    // Search
    static let searchPrompt = String(localized: "Search your meetings")
    static let searchHint = String(localized: "Search titles, notes and transcripts.")
    static func noResults(_ q: String) -> String { String(localized: "Nothing matches “\(q)”.") }
    // whole sentences, so each language can say "in the title" its own way
    static let foundInTitle = String(localized: "In the title")
    static let foundInMine = String(localized: "In My notes")
    static let foundInSummary = String(localized: "In the summary")
    static let foundInTranscript = String(localized: "In the transcript")

    // Settings
    static let done = String(localized: "Done")
    static let computer = String(localized: "Computer")
    static let onPhoneOnly = String(localized: "On this iPhone only")
    static let connectFooter = String(localized: "Connect to see your computer's meetings here too. Everything still works without it.")
    static let connectComputer = String(localized: "Connect to your computer")
    static let syncNow = String(localized: "Sync now")
    static let unpair = String(localized: "Unpair")
    static func unpairTitle(_ name: String) -> String { String(localized: "Unpair from \(name)?") }
    static let unpairTitleNoName = String(localized: "Unpair from your computer?")
    static let unpairBody = String(localized: "Meetings from your computer are removed from this iPhone. They stay on your computer, and you can connect again any time.")
    static func unpairUnsent(_ n: Int) -> String {
        n == 1 ? String(localized: "1 change hasn't reached your computer yet and will be lost.")
            : String(localized: "\(n) changes haven't reached your computer yet and will be lost.")
    }
    static let spokenLanguage = String(localized: "Spoken language")
    static func sameAsIPhone(_ language: String) -> String { String(localized: "Same as iPhone (\(language))") }
    static let forThisRecording = String(localized: "For this recording only. Settings keeps your usual language.")
    static let spokenFooter = String(localized: "The language people speak in your meetings. Yogurt writes the transcript and notes in it.")
    static let privacy = String(localized: "Privacy")
    static let faceIDLock = String(localized: "Lock with Face ID")
    static let faceIDFooter = String(localized: "Yogurt asks for Face ID when you open it.")
    static let faceIDNeedsPasscode = String(localized: "Set a passcode on this iPhone to use this.")
    static let permissions = String(localized: "Permissions")
    static let permissionsFooter = String(localized: "Yogurt uses these to record and transcribe on this iPhone.")
    static let accessOn = String(localized: "On")
    static let accessOff = String(localized: "Off")
    static let accessNotAsked = String(localized: "Not asked yet")
    static let storage = String(localized: "Storage")
    static let meetingsOnPhone = String(localized: "Meetings on this iPhone")
    static let spaceUsed = String(localized: "Space used")
    static let sampleOn = String(localized: "You're looking at sample meetings. Unpair to remove them.")
    static func codeDigits(_ n: Int) -> String { String(localized: "\(n) of 6 digits") }

    // Lock
    static let locked = String(localized: "Yogurt is locked")
    static let unlock = String(localized: "Unlock")
    static let unlockReason = String(localized: "Unlock to see your meetings.")
    static let unlockFailed = String(localized: "Couldn't check it's you. Try again.")

    // Errors
    static let storeFailed = String(localized: "Yogurt couldn't open its storage on this iPhone. Restart your iPhone and try again.")
}
