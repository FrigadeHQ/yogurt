import Foundation

/// The language people speak in meetings recorded on this iPhone: the iPhone's own unless one was picked in Settings.
/// The live transcript listens in it, the draft notes are written in it, and the computer is told it with the upload.
public enum SpokenLanguage {
    /// where the pick is kept (UserDefaults); empty or missing is "Same as iPhone"
    public static let defaultsKey = "spokenLanguage"

    public struct Option: Sendable, Hashable, Identifiable {
        /// BCP-47, e.g. "de-DE", as it is stored
        public var id: String
        public var name: String
    }

    /// The locale to listen in. supported: what this iPhone can transcribe; a pick it no longer has goes back to the
    /// iPhone's language. nil or empty means not known yet, so the pick stays.
    public static func locale(picked: String?, phone: Locale, supported: [Locale]? = nil) -> Locale {
        guard let picked, !picked.isEmpty else { return phone }
        let locale = Locale(identifier: picked)
        if let supported, !supported.isEmpty, !supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) { return phone }
        return locale
    }

    /// Settings' list: each locale once, named and sorted in the interface's language.
    public static func options(_ supported: [Locale], in interface: Locale) -> [Option] {
        var seen = Set<String>()
        let unique = supported.map { $0.identifier(.bcp47) }.filter { seen.insert($0).inserted }
        let named = unique.map { Option(id: $0, name: interface.localizedString(forIdentifier: $0) ?? $0) }
        return named.sorted { $0.name.compare($1.name, locale: interface) == .orderedAscending }
    }

    /// "English" for en_US, in the interface's language: for "Same as iPhone (English)".
    public static func name(of locale: Locale, in interface: Locale) -> String {
        let code = locale.language.languageCode?.identifier ?? "en"
        return interface.localizedString(forLanguageCode: code) ?? code
    }

    /// What the computer is told: the language's code ("de"), which is all whisper takes.
    public static func code(_ locale: Locale) -> String? {
        locale.language.languageCode?.identifier
    }
}
