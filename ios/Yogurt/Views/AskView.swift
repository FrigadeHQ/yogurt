import SwiftUI
import YogurtKit

/// Ask across meetings, like desktop's Ask: a question box with scope chips, and answers whose numbered sources open
/// the meeting at the moment they come from. The computer answers when it's on the same Wi-Fi, else Apple's model here.
struct AskView: View {
    /// opened from a note: asks about that meeting first
    let meetingId: String?
    @Environment(AppModel.self) private var model
    @State private var session = AskSession.shared
    @State private var text = ""
    @State private var scope: Choice?
    @FocusState private var focused: Bool

    enum Choice: Hashable { case meeting(String), folder(String), all }

    private var key: String { meetingId ?? "home" }

    var body: some View {
        let _ = model.revision
        let turns = session.turns(key)
        let answerer = AskSession.whereAnswered(model)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if turns.isEmpty {
                        intro(answerer)
                    }
                    ForEach(turns) { turn in
                        TurnView(turn: turn) { session.retry(turn.id, key: key, model: model) }
                            .padding(.top, 24)
                            .id(turn.id)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: turns.count) { _, _ in
                if let last = turns.last { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .top) } }
            }
        }
        .background(Theme.bg)
        .navigationTitle(S.ask)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { if answerer != .nowhere { askBar } }
        .onAppear(perform: launch)
    }

    // MARK: - Before the first question

    @ViewBuilder private func intro(_ answerer: AskSession.Where) -> some View {
        Text(S.askTitle)
            .font(Theme.brand(28, relativeTo: .largeTitle))
            .foregroundStyle(Theme.heading)
            .padding(.top, 12)
        if answerer == .nowhere {
            unavailable.padding(.top, 20)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(starters, id: \.self) { q in
                    Button { send(q) } label: {
                        Text(q).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                            .multilineTextAlignment(.leading)
                            .padding(.horizontal, 14).padding(.vertical, 11)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 20)
        }
    }

    /// No computer nearby and no Apple Intelligence here: say so, and offer Search, which always works.
    private var unavailable: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(S.askNeedsModel, systemImage: "iphone")
                .font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text(S.askSearchInstead).font(.subheadline).foregroundStyle(Theme.muted)
            NavigationLink(value: Route.search) {
                Label(S.searchMeetings, systemImage: "magnifyingglass").padding(.horizontal, 4)
            }
            .buttonStyle(PrimaryButtonStyle())
            .padding(.top, 4)
            .accessibilityIdentifier("ask-search")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var starters: [String] {
        meetingId != nil && chosen == .meeting(meetingId!)
            ? [S.askMeetingStarter1, S.askMeetingStarter2, S.askMeetingStarter3]
            : [S.askStarter1, S.askStarter2, S.askStarter3]
    }

    // MARK: - The question box

    private var chosen: Choice {
        let folders = model.store.folders()
        switch scope {
        case .folder(let id) where !folders.contains { $0.id == id }: return .all
        case let s?: return s
        case nil: return meetingId.map(Choice.meeting) ?? .all
        }
    }

    private var askBar: some View {
        let busy = session.busy
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(spacing: 10) {
            chips
            HStack(alignment: .bottom, spacing: 8) {
                TextField(chosen == .meeting(meetingId ?? "") ? S.askAnything : S.askPrompt, text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit { send(q) }
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .accessibilityIdentifier("ask-field")
                Button { send(q) } label: {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.semibold)).foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(Theme.primary.opacity(q.isEmpty || busy ? 0.4 : 1), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(q.isEmpty || busy)
                .accessibilityLabel(S.askSend)
                .accessibilityIdentifier("ask-send")
            }
            .padding(.horizontal, 16)
        }
        .padding(.top, 10).padding(.bottom, 8)
        .background(Theme.bg)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    /// This meeting (from a note), each folder, All meetings
    private var chips: some View {
        let folders = model.store.folders()
        return ScrollView(.horizontal) {
            HStack(spacing: 8) {
                if let meetingId { chip(S.askThisMeeting, .meeting(meetingId), dot: false) }
                chip(S.allMeetings, .all, dot: false)
                ForEach(folders) { chip($0.name, .folder($0.id), dot: true) }
            }
            .padding(.horizontal, 16)
        }
        .scrollIndicators(.hidden)
    }

    private func chip(_ name: String, _ choice: Choice, dot: Bool) -> some View {
        let on = chosen == choice
        return Button { withAnimation(.easeOut(duration: 0.15)) { scope = choice } } label: {
            HStack(spacing: 6) {
                if dot { Circle().fill(Theme.accent).frame(width: 6, height: 6) }
                Text(name).lineLimit(1)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(on ? Theme.ink : Theme.written)
            .padding(.horizontal, 11)
            .frame(height: 30)
            .background(on ? Theme.selected : .clear, in: Capsule())
            .overlay(Capsule().strokeBorder(on ? .clear : Theme.line, lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func send(_ question: String) {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, !session.busy else { return }
        let (scope, name): (AskScope?, String) = switch chosen {
        case .meeting(let id): (AskScope(meetingIds: [id]), S.askThisMeeting)
        case .folder(let id): (AskScope(folderId: id), model.store.folders().first { $0.id == id }?.name ?? S.allMeetings)
        case .all: (nil, S.allMeetings)
        }
        session.ask(q, scope: scope, scopeName: name, key: key, model: model)
        text = ""
        focused = false
    }

    private func launch() {
        #if DEBUG
        // screenshots: -openAsk "question" asks it once
        if let q = UserDefaults.standard.string(forKey: "openAsk") {
            if !q.isEmpty, session.turns(key).isEmpty { send(q) }
            return
        }
        #endif
        if session.turns(key).isEmpty && AskSession.whereAnswered(model) != .nowhere { focused = true }
    }
}

/// One question and its answer.
private struct TurnView: View {
    let turn: AskSession.Turn
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(turn.question)
                .font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 40)
            switch turn.state {
            case .answering:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(S.askReading).font(.subheadline).foregroundStyle(Theme.muted)
                }
            case .failed:
                VStack(alignment: .leading, spacing: 8) {
                    Text(S.askFailed).font(.subheadline).foregroundStyle(Theme.danger)
                    Button(S.tryAgain, action: retry).font(.subheadline.weight(.semibold))
                }
            case .answered(let a):
                AnswerBody(text: a.text).textSelection(.enabled)
                HStack(spacing: 6) {
                    Image(systemName: a.by == .computer ? "laptopcomputer" : "iphone").font(.caption)
                    Text([a.by == .computer ? S.askByComputer : S.askByPhone, S.askIn(turn.scopeName)].joined(separator: " · "))
                }
                .font(.caption).foregroundStyle(Theme.muted)
                .accessibilityElement(children: .combine)
                if !a.sources.isEmpty { SourcesView(sources: a.sources) }
            }
        }
    }
}

/// The answer's Markdown (bold, "- " bullets) with each [n] in purple, matching the numbered sources below it.
private struct AnswerBody: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("- ") || t.hasPrefix("* ") {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(Theme.muted)
                        styled(String(t.dropFirst(2)))
                    }
                } else if !t.isEmpty {
                    styled(t)
                }
            }
        }
        .font(.body)
        .foregroundStyle(Theme.ink)
        .lineSpacing(3)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func styled(_ line: String) -> Text {
        var out = AttributedString()
        var rest = Substring(line)
        while let m = rest.firstMatch(of: /\[\d+(?:,\s*\d+)*\]/) {
            out += inline(String(rest[..<m.range.lowerBound]))
            var cite = AttributedString(String(rest[m.range]))
            cite.font = .footnote.weight(.semibold)
            cite.foregroundColor = Theme.accent
            out += cite
            rest = rest[m.range.upperBound...]
        }
        out += inline(String(rest))
        return Text(out)
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

/// The numbered sources; each opens its meeting, in the transcript at the moment when there is one.
private struct SourcesView: View {
    let sources: [AskSource]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(S.askSources).font(.footnote.weight(.medium)).foregroundStyle(Theme.muted).padding(.bottom, 4)
            ForEach(sources) { s in
                NavigationLink(value: s.atMs.map { Route.transcript(s.meetingId, $0) } ?? Route.meeting(s.meetingId)) {
                    row(s)
                }
                .buttonStyle(RowButtonStyle())
                .padding(.horizontal, -8)
                .accessibilityHint(s.atMs == nil ? S.openNote : S.openInTranscript)
            }
        }
        .padding(.top, 4)
    }

    /// the excerpt as one line of plain words: no headings, bullets or bold marks
    private func plain(_ text: String) -> String {
        text.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces).replacing(/^(#+|[-*]|\d+\.)\s+/, with: "") }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .replacingOccurrences(of: "**", with: "")
    }

    private func row(_ s: AskSource) -> some View {
        let title = s.title.isEmpty ? S.untitled : s.title
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(s.n)")
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(Theme.accent)
                .frame(minWidth: 22, minHeight: 22)
                .background(Theme.accentSoft, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(s.atMs.map { S.sourceAt(title, Format.offset($0)) } ?? S.sourceAt(title, S.notesSource))
                    .font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(1)
                if !s.excerpt.isEmpty {
                    Text(plain(s.excerpt))
                        .font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.forward").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
        }
        .padding(.vertical, 10).padding(.horizontal, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
