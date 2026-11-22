import Foundation
@preconcurrency import Speech
import YogurtKit

/// The spoken language picked in Settings, read where recording and notes need it.
enum Spoken {
    static var picked: String? { UserDefaults.standard.string(forKey: SpokenLanguage.defaultsKey) }

    /// The language to listen in now: the pick, else the iPhone's.
    static var current: Locale { SpokenLanguage.locale(picked: picked, phone: .current) }

    /// Every language this iPhone can transcribe on the device: SpeechAnalyzer's (its models download when first
    /// used), and the older recogniser's on-device ones.
    static func supported() async -> [Locale] {
        var list = SpeechTranscriber.isAvailable ? await SpeechTranscriber.supportedLocales : []
        let older = await Task.detached(priority: .utility) {
            SFSpeechRecognizer.supportedLocales().filter { SFSpeechRecognizer(locale: $0)?.supportsOnDeviceRecognition == true }
        }.value
        list += older
        return list
    }
}

extension LocalRecording {
    /// What it was recorded in; one from before the setting was recorded in the iPhone's language.
    var spokenLocale: Locale { language.map(Locale.init(identifier:)) ?? .current }
}
