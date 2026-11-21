import Foundation

/// Text for recording on the phone, kept with it (see Strings.swift for the rest).
extension S {
    static let recording = "Recording"
    static let paused = "Paused"
    static let pausedForCall = "Paused while another app uses the microphone"
    static let pause = "Pause"
    static let resume = "Resume"
    static let stop = "Stop"
    static let starting = "Starting…"
    static let savingRecording = "Saving…"
    static let close = "Close"
    static let liveTranscript = "Transcript"
    static let listening = "Listening…"
    static let transcriptWaiting = "The transcript shows up here as people talk."
    static let myNotesWhileRecording = "Type notes as you go. Yogurt uses them to write better notes."
    static func meetingAt(_ time: String) -> String { "Meeting at \(time)" }
    static let recordedTime = "Recorded time"
    static let micLevel = "Microphone level"

    static let micOff = "Yogurt can't use the microphone. Turn it on in Settings to record."
    static let recordingCantStart = "The recording couldn't start. Close other apps using the microphone and try again."
    static let recordingSaveFailed = "Your recording is kept, but it couldn't be saved as a meeting yet. Open Yogurt again to finish."
    static let recordingWriteFailed = "Part of the audio couldn't be saved. The transcript and your notes are still kept."
    static func transcriptDownloading(_ language: String) -> String {
        "Getting the \(language) transcript ready on this iPhone. This happens once; the recording has already started."
    }
    static let transcriptUnavailable = "This iPhone can't write a live transcript in your language. Your recording is still saved."
    static let transcriptNeedsSpeech = "Turn on Speech recognition in Settings to see the transcript. Your recording is still saved."

    // Home and the note, until the computer has it
    static let recordedHere = "Recorded on this iPhone"
    static let waitingForComputer = "waiting for your computer"
    static let writingNotes = "Writing notes…"
    static let notesFromComputer = "Notes will be written when your computer has it."
    static let notesNeedAppleIntelligence = "Notes need Apple Intelligence on this iPhone. Your transcript is saved."
    static let notesNotWritten = "Couldn't write notes on this iPhone. Your transcript is saved."
    static let tryAgain = "Try again"
}
