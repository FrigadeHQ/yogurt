import SwiftUI
import YogurtKit

extension Spoken {
    static func selectionName(_ id: String) -> String {
        if id.isEmpty { return S.sameAsIPhone(SpokenLanguage.name(of: .current, in: .current)) }
        return Locale.current.localizedString(forIdentifier: id) ?? id
    }

    /// "Same as iPhone (…)" first, then every language this iPhone transcribes: used in Settings and while recording.
    @ViewBuilder static func choices(selection: String, languages: [SpokenLanguage.Option]) -> some View {
        Text(selectionName("")).tag("")
        // a pick this iPhone no longer lists still shows, so the row never reads blank
        if !selection.isEmpty, !languages.contains(where: { $0.id == selection }) {
            Text(selectionName(selection)).tag(selection)
        }
        ForEach(languages) { Text($0.name).tag($0.id) }
    }
}

/// A selection returns to the screen that opened the list.
struct SpokenLanguageList: View {
    @Binding var selection: String
    var hint: String? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var languages: [SpokenLanguage.Option] = []

    var body: some View {
        List {
            Section {
                Picker(selection: Binding(get: { selection }, set: { selection = $0; dismiss() })) {
                    Spoken.choices(selection: selection, languages: languages)
                } label: { Text(S.spokenLanguage) }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                if let hint {
                    Text(hint)
                        .font(.subheadline)
                        .foregroundStyle(Theme.muted)
                        .textCase(nil)
                        .padding(.bottom, 8)
                }
            }
            .listRowBackground(Theme.card)
            .listRowSeparator(.hidden)
        }
        .environment(\.defaultMinListRowHeight, 50)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .tint(Theme.accent)
        .task { languages = SpokenLanguage.options(await Spoken.supported(), in: .current) }
    }
}
