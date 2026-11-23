import SwiftUI
import YogurtKit

extension Spoken {
    /// "Same as iPhone (…)" first, then every language this iPhone transcribes: Settings' list and the one beside Record.
    @ViewBuilder static func choices(selection: String, languages: [SpokenLanguage.Option]) -> some View {
        Text(S.sameAsIPhone(SpokenLanguage.name(of: .current, in: .current))).tag("")
        // a pick this iPhone no longer lists still shows, so the row never reads blank
        if !selection.isEmpty, !languages.contains(where: { $0.id == selection }) {
            Text(Locale.current.localizedString(forIdentifier: selection) ?? selection).tag(selection)
        }
        ForEach(languages) { Text($0.name).tag($0.id) }
    }

    /// The language to listen in for one recording: its own pick (nil: none, so Settings'), else the iPhone's.
    static func locale(override: String?) -> Locale { SpokenLanguage.locale(picked: override ?? picked, phone: .current) }
}

/// Beside Record on Home: the language the next recording listens in, changed for that one only (Settings keeps the
/// usual one). Quiet like desktop's language menu in a note's footer; tapping Record still records straight away.
struct SpokenLanguageChip: View {
    /// nil: Settings' language
    @Binding var override: String?
    @AppStorage(SpokenLanguage.defaultsKey) private var spoken = ""
    @State private var picking = false

    var body: some View {
        let name = SpokenLanguage.name(of: Spoken.locale(override: override), in: .current)
        Button { picking = true } label: {
            HStack(spacing: 5) {
                Image(systemName: "globe").font(.caption)
                Text(name).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(Theme.written)
            .padding(.horizontal, 12)
            .frame(minHeight: 34)
            .background(Theme.card, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 0.5))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .contentTransition(.opacity)
        .animation(.easeOut(duration: 0.18), value: name)
        .accessibilityLabel(S.spokenLanguage)
        .accessibilityValue(name)
        .accessibilityHint(S.forNextRecording)
        .accessibilityIdentifier("record-language")
        .sheet(isPresented: $picking) {
            SpokenLanguageSheet(selection: Binding(get: { override ?? spoken }, set: { override = $0 }))
        }
        .onAppear {
            #if DEBUG
            if UserDefaults.standard.bool(forKey: "openRecordLanguage") { picking = true }
            #endif
        }
    }
}

/// The languages to pick from for the next recording; picking one closes it.
struct SpokenLanguageSheet: View {
    @Binding var selection: String
    @Environment(\.dismiss) private var dismiss
    @State private var languages: [SpokenLanguage.Option] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker(selection: Binding(get: { selection }, set: { selection = $0; dismiss() })) {
                        Spoken.choices(selection: selection, languages: languages)
                    } label: { EmptyView() }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } footer: { Text(S.forNextRecording) }
                .listRowBackground(Theme.card)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .tint(Theme.accent)
            .navigationTitle(S.spokenLanguage)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button(S.done) { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
        .task { languages = SpokenLanguage.options(await Spoken.supported(), in: .current) }
    }
}
