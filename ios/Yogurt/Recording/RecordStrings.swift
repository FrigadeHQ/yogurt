import Foundation

/// Text for recording on the phone, kept with it (see Strings.swift for the rest).
extension S {
    static let recording = String(localized: "Recording")
    static let paused = String(localized: "Paused")
    static let stopped = String(localized: "Stopped")
    static let pausedForCall = String(localized: "Paused while another app uses the microphone")
    static let pause = String(localized: "Pause")
    static let resume = String(localized: "Resume")
    static let stop = String(localized: "Stop")
    static let starting = String(localized: "Starting…")
    static let savingRecording = String(localized: "Saving…")
    static let close = String(localized: "Close")
    static let liveTranscript = String(localized: "Transcript")
    static let listening = String(localized: "Listening…")
    static let transcriptWaiting = String(localized: "The transcript shows up here as people talk.")
    static let myNotesWhileRecording = String(localized: "Type notes as you go. Yogurt uses them to write better notes.")
    static func meetingAt(_ time: String) -> String { String(localized: "Meeting at \(time)") }
    static let recordedTime = String(localized: "Recorded time")
    static let micLevel = String(localized: "Microphone level")

    static let micOff = String(localized: "Yogurt can't use the microphone. Turn it on in Settings to record.")
    static let recordingCantStart = String(localized: "The recording couldn't start. Close other apps using the microphone and try again.")
    static let recordingSaveFailed = String(localized: "Your recording is kept, but it couldn't be saved as a meeting yet. Open Yogurt again to finish.")
    static let recordingWriteFailed = String(localized: "The recording stopped because the audio couldn't be saved any more.")
    static let recordingDiskFull = String(localized: "The recording stopped because your iPhone is full.")
    static let recordingAudioReset = String(localized: "The recording stopped because your iPhone restarted its audio.")
    static let recordingKeptAsMeeting = String(localized: "Everything recorded until then is saved as a meeting.")
    static let recordingNoSpace = String(localized: "Your iPhone is almost full. Free up some space to record.")
    static let recordingLowSpace = String(localized: "Your iPhone is low on space. A long meeting might not fit.")
    static let recordingPausedTitle = String(localized: "Recording paused")
    static let recordingPausedBody = String(localized: "Another app is using the microphone. Tap to keep recording.")
    static let notificationsOff = String(localized: "Notifications are off, so if a call pauses the recording, you'll see it only when you open Yogurt.")
    static let discard = String(localized: "Discard")
    static let discardQuestion = String(localized: "Discard this recording? It can't be recovered.")
    static let keepRecording = String(localized: "Keep recording")
    static func transcriptDownloading(_ language: String) -> String {
        String(localized: "Getting \(language) ready for transcripts on this iPhone. This happens once; the recording has already started.")
    }
    static let transcriptUnavailable = String(localized: "This iPhone can't write a live transcript in your language. Your recording is still saved.")
    static let transcriptNeedsSpeech = String(localized: "Turn on Speech recognition in Settings to see the transcript. Your recording is still saved.")

    // Home and the note, until the computer has it
    static let recordedHere = String(localized: "Recorded on this iPhone")
    static let waitingForComputer = String(localized: "waiting for your computer")
    static let writingNotes = String(localized: "Writing notes…")
    static let notesFromComputer = String(localized: "Notes will be written when your computer has it.")
    static let notesNeedAppleIntelligence = String(localized: "Notes need Apple Intelligence on this iPhone. Your transcript is saved.")
    static let notesNotWritten = String(localized: "Couldn't write notes on this iPhone. Your transcript is saved.")
    static let notesWhenModelReady = String(localized: "Apple Intelligence is getting ready on this iPhone. Your notes are written once it is.")
    static func notesNeedLanguage(_ language: String) -> String {
        String(localized: "Apple Intelligence can't write notes in \(language) yet. Your transcript is saved.")
    }
    static let tryAgain = String(localized: "Try again")
}
