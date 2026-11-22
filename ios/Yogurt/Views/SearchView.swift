import SwiftUI
import YogurtKit

/// Search across every meeting on the phone, offline. Each result shows where the words were found.
struct SearchView: View {
    let open: (String) -> Void
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var hits: [StoreReader.Found] = []
    /// the query the hits are for, so "Nothing matches" never shows for words still being searched
    @State private var searched = ""
    @FocusState private var focused: Bool

    var body: some View {
        let revision = model.revision
        let q = query.trimmingCharacters(in: .whitespaces)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if q.isEmpty {
                    hint(S.searchHint)
                } else if hits.isEmpty {
                    if searched == q { hint(S.noResults(q)) }
                } else {
                    ForEach(hits) { found in
                        Button { open(found.hit.meetingId) } label: { row(found) }
                            .buttonStyle(RowButtonStyle())
                            .padding(.horizontal, -8)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
        .scrollDismissesKeyboard(.immediately)
        .background(Theme.bg)
        .navigationTitle(S.search)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: S.searchPrompt)
        .searchFocused($focused)
        // a short pause after typing, then the search runs on the reader's own connection, off the main thread
        .task(id: "\(revision)|\(q)") {
            guard !q.isEmpty else { hits = []; searched = ""; return }
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            let found = await model.reader.search(q, limit: 50)
            guard !Task.isCancelled else { return }
            hits = found
            searched = q
        }
        .onAppear {
            #if DEBUG
            if query.isEmpty, let q = UserDefaults.standard.string(forKey: "openSearch") { query = q }
            #endif
            if query.isEmpty { focused = true }
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.subheadline).foregroundStyle(Theme.muted).padding(.top, 24).frame(maxWidth: .infinity)
    }

    private func row(_ found: StoreReader.Found) -> some View {
        let hit = found.hit
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(hit.title.isEmpty ? S.personalNotes : hit.title)
                    .font(.body.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 8)
                if let started = found.startedAt {
                    Text(Format.day(started)).font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            if hit.field != .title {
                Text(foundIn(hit.field)).font(.caption.weight(.medium)).foregroundStyle(Theme.muted)
                highlighted(hit).font(.subheadline).foregroundStyle(Theme.written).lineLimit(3)
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func highlighted(_ hit: SearchHit) -> Text {
        var s = AttributedString(hit.snippet)
        for r in hit.highlights {
            guard let lower = AttributedString.Index(r.lowerBound, within: s),
                  let upper = AttributedString.Index(r.upperBound, within: s) else { continue }
            s[lower..<upper].font = .subheadline.weight(.semibold)
            s[lower..<upper].foregroundColor = Theme.ink
        }
        return Text(s)
    }

    private func foundIn(_ f: SearchHit.Field) -> String {
        switch f {
        case .title: S.foundInTitle
        case .mine: S.foundInMine
        case .summary: S.foundInSummary
        case .transcript: S.foundInTranscript
        }
    }
}
