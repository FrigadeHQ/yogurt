import AVFAudio
import Speech
import UIKit

/// The two things Yogurt asks iOS for: the microphone to record, speech recognition to write the transcript.
enum Permission: CaseIterable {
    case microphone, speech

    enum Access { case on, off, notAsked }

    var access: Access {
        switch self {
        case .microphone:
            switch AVAudioApplication.shared.recordPermission {
            case .granted: .on
            case .denied: .off
            default: .notAsked
            }
        case .speech:
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: .on
            case .denied, .restricted: .off
            default: .notAsked
            }
        }
    }

    var name: String { self == .microphone ? S.micTitle : S.speechTitle }
    var symbol: String { self == .microphone ? "mic" : "waveform" }

    /// Shows the system prompt. True when it was turned on.
    func request() async -> Bool {
        switch self {
        case .microphone: await AVAudioApplication.requestRecordPermission()
        case .speech: await Self.requestSpeech() == .authorized
        }
    }

    /// Not on the main actor: iOS calls back on a queue of its own.
    private nonisolated static func requestSpeech() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { done in SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) } }
    }

    /// Once turned off, only the Settings app can turn it back on.
    @MainActor static func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
}
