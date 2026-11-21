import SwiftUI
import YogurtKit

/// One meeting: Summary, My notes and Transcript, as on desktop. My notes can be edited here; it saves as you type and
/// goes to the computer with the next sync.
struct NoteView: View {
    enum Tab: String, CaseIterable { case summary, mine, transcript }

    let meetingId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var tab: Tab?
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var toast: String?

    var body: some View {
        let _ = model.engine.revision
        Group {
            if let meeting = model.store.meeting(meetingId) {
                content(meeting)
            } else {
                Text(S.notFound).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) { toastView }
    }

    private func content(_ meeting: Meeting) -> some View {
        let notes = model.store.notes(meetingId)
        let folders = model.store.folders()
        let inFolders = folders.filter { f in model.store.meetings(folder: f.id).contains { $0.id == meetingId } }
        let shown = tab ?? defaultTab(notes)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header(meeting, folders: inFolders)
                if meeting.trashedAt != nil { trashBanner }
                tabs(shown)
                Group {
                    switch shown {
                    case .summary: SummaryPane(notes: notes)
                    case .mine: MyNotesPane(meetingId: meetingId, initial: notes?.mine ?? "")
                    case .transcript: TranscriptPane(segments: model.store.segments(meetingId))
                    }
                }
                .padding(.top, 20)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { menu(meeting, folders: folders, inFolders: inFolders) }
        }
        .alert(S.renameTitle, isPresented: $renaming) {
            TextField(S.title, text: $newTitle)
            Button(S.save) {
                let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty, title != meeting.title { change(Op(kind: .rename, meetingId: meetingId, title: title)) }
            }
            Button(S.cancel, role: .cancel) {}
        }
        .onAppear {
            #if DEBUG
            if tab == nil, let t = UserDefaults.standard.string(forKey: "openTab") { tab = Tab(rawValue: t) }
            #endif
        }
    }

    private func header(_ m: Meeting, folders: [Folder]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(m.title.isEmpty ? S.personalNotes : m.title)
                .font(.title2.weight(.semibold))
                .tracking(-0.4)
                .foregroundStyle(Theme.heading)
                .onTapGesture { newTitle = m.title; renaming = true }
            HStack(spacing: 6) {
                Text([Format.day(m.startedAt), Format.time(m.startedAt), Format.duration(m)].compactMap { $0 }.joined(separator: " · "))
                if !m.attendees.isEmpty {
                    Text("·")
                    Image(systemName: "person.2").font(.caption)
                    Text(Format.people(m.attendees))
                }
            }
            .font(.subheadline)
            .foregroundStyle(Theme.muted)
            .lineLimit(1)
            if !folders.isEmpty {
                HStack(spacing: 6) { ForEach(folders) { FolderPill(name: $0.name) } }.padding(.top, 2)
            }
        }
        .padding(.top, 4)
    }

    private var trashBanner: some View {
        HStack {
            Image(systemName: "trash").foregroundStyle(Theme.muted)
            Text(S.inTrash).font(.subheadline).foregroundStyle(Theme.ink)
            Spacer()
            Button(S.restore) { change(Op(kind: .restore, meetingId: meetingId)) }
                .font(.subheadline.weight(.semibold))
        }
        .padding(12)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.top, 16)
    }

    /// desktop's tab row: plain labels over a hairline, the chosen one underlined in purple
    private func tabs(_ shown: Tab) -> some View {
        HStack(spacing: 22) {
            ForEach(Tab.allCases, id: \.self) { t in
                Button {
                    withAnimation(.easeOut(duration: 0.18)) { tab = t }
                } label: {
                    Text(label(t))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(shown == t ? Theme.ink : Theme.muted)
                        .padding(.horizontal, 2)
                        .frame(height: 40)
                        .overlay(alignment: .bottom) {
                            if shown == t {
                                Rectangle().fill(Theme.primary).frame(height: 2)
                                    .matchedGeometryEffect(id: "underline", in: underline)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(shown == t ? .isSelected : [])
                .accessibilityIdentifier("tab-\(t.rawValue)")
            }
            Spacer()
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
        .padding(.top, 20)
    }

    @Namespace private var underline

    private func label(_ t: Tab) -> String {
        switch t {
        case .summary: S.summary
        case .mine: S.myNotes
        case .transcript: S.transcript
        }
    }

    private func defaultTab(_ notes: Notes?) -> Tab {
        if notes?.summary?.isEmpty == false { return .summary }
        return .mine
    }

    private func menu(_ m: Meeting, folders: [Folder], inFolders: [Folder]) -> some View {
        Menu {
            Button { newTitle = m.title; renaming = true } label: { Label(S.rename, systemImage: "pencil") }
            Menu {
                if folders.isEmpty { Text(S.noFolders) }
                ForEach(folders) { f in
                    let member = inFolders.contains(f)
                    Button {
                        change(Op(kind: member ? .removeFromFolder : .addToFolder, meetingId: meetingId, folderId: f.id))
                    } label: {
                        if member { Label(f.name, systemImage: "checkmark") } else { Text(f.name) }
                    }
                }
            } label: { Label(S.addToFolder, systemImage: "folder") }
            if m.trashedAt == nil {
                Divider()
                Button(role: .destructive) {
                    change(Op(kind: .trash, meetingId: meetingId))
                    dismiss()
                } label: { Label(S.moveToTrash, systemImage: "trash") }
            }
        } label: {
            Image(systemName: "ellipsis").accessibilityLabel(S.more)
        }
    }

    /// Edits other than My notes show once the computer has taken them, so say when that has to wait.
    private func change(_ op: Op) {
        model.send(op)
        if case .connected = model.engine.status { return }
        withAnimation { toast = S.changeQueued }
        Task {
            try? await Task.sleep(for: .seconds(3))
            withAnimation { toast = nil }
        }
    }

    @ViewBuilder private var toastView: some View {
        if let toast {
            Text(toast)
                .font(.footnote)
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.float, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.line))
                .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
                .padding(.bottom, 16).padding(.horizontal, 20)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

// MARK: - Panes

struct SummaryPane: View {
    let notes: Notes?
    var body: some View {
        if let summary = notes?.summary, !summary.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                if notes?.summarySource == .phoneDraft {
                    Label(S.draftSummary, systemImage: "iphone")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
                MarkdownView(markdown: summary, color: Theme.written)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text(S.noSummary).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                Text(S.noSummaryBody).font(.subheadline).foregroundStyle(Theme.muted)
            }
        }
    }
}

/// My notes, saved a second after typing stops (and on leaving), as one queued edit for the computer.
struct MyNotesPane: View {
    let meetingId: String
    @Environment(AppModel.self) private var model
    @State private var text: String
    @State private var state: SaveState = .saved
    @State private var saveTask: Task<Void, Never>?
    @FocusState private var focused: Bool

    enum SaveState { case saved, saving, failed }

    init(meetingId: String, initial: String) {
        self.meetingId = meetingId
        _text = State(initialValue: initial)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topLeading) {
                if text.isEmpty {
                    Text(S.myNotesPlaceholder)
                        .foregroundStyle(Theme.muted)
                        .padding(.top, 8).padding(.leading, 5)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $text)
                    .focused($focused)
                    .scrollDisabled(true)
                    .scrollContentBackground(.hidden)
                    .foregroundStyle(Theme.ink)
                    .lineSpacing(4)
                    .frame(minHeight: 280, alignment: .topLeading)
                    .accessibilityLabel(S.myNotes)
                    .accessibilityIdentifier("my-notes")
            }
            .font(.body)
            .padding(.horizontal, -5)
            Text(stateLabel)
                .font(.caption)
                .foregroundStyle(state == .failed ? Theme.danger : Theme.muted)
                .contentTransition(.opacity)
        }
        .onChange(of: text) { _, _ in schedule() }
        .onDisappear { if state == .saving { save() } }
    }

    private var stateLabel: String {
        switch state {
        case .saved: S.savedHere
        case .saving: S.saving
        case .failed: S.notSaved
        }
    }

    private func schedule() {
        state = .saving
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            save()
        }
    }

    private func save() {
        saveTask?.cancel()
        // skip when nothing changed, so opening a note never queues an edit
        guard model.store.notes(meetingId)?.mine != text else { state = .saved; return }
        do {
            try model.store.editMine(meetingId: meetingId, text: text)
            state = .saved
            Task { await model.engine.syncNow() }
        } catch {
            state = .failed
        }
    }
}

struct TranscriptPane: View {
    let segments: [Segment]

    var body: some View {
        if segments.isEmpty {
            Text(S.noTranscript).font(.subheadline).foregroundStyle(Theme.muted)
        } else {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(turns, id: \.first.index) { turn in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(speaker(turn.first.speaker))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(turn.first.speaker == "me" ? Theme.accent : Theme.ink)
                            Text(Format.offset(turn.first.startMs))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(Theme.muted)
                        }
                        Text(turn.text)
                            .font(.body)
                            .foregroundStyle(Theme.written)
                            .lineSpacing(4)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    /// back-to-back lines from the same speaker read as one turn
    private var turns: [(first: Segment, text: String)] {
        var out: [(first: Segment, text: String)] = []
        for s in segments {
            if let last = out.last, last.first.speaker == s.speaker {
                out[out.count - 1].text += " " + s.text
            } else {
                out.append((s, s.text))
            }
        }
        return out
    }

    private func speaker(_ s: String?) -> String {
        switch s {
        case "me": S.me
        case nil: S.them
        case let name?: name
        }
    }
}

/// Renders the desktop's Markdown: headings, bullets (nested ones with a dash), numbers, tasks, bold and links.
struct MarkdownView: View {
    let markdown: String
    var color: Color = Theme.ink

    var body: some View {
        let blocks = markdownBlocks(markdown)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { i, block in
                view(block).padding(.top, topSpace(block, first: i == 0))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder private func view(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            inline(text, font: level == 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .body.weight(.semibold), color: Theme.heading)
                .accessibilityAddTraits(.isHeader)
        case .bullet(let level, let text):
            item(level == 0 ? "•" : "–", level: level, text: text)
        case .numbered(let n, let level, let text):
            item("\(n).", level: level, text: text)
        case .task(let done, let level, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: done ? "checkmark.square" : "square").foregroundStyle(Theme.muted)
                inline(text).strikethrough(done, color: Theme.muted)
            }
            .padding(.leading, CGFloat(level) * 18)
        case .paragraph(let text):
            inline(text)
        case .rule:
            Rectangle().fill(Theme.line).frame(height: 1).padding(.vertical, 6)
        }
    }

    private func item(_ marker: String, level: Int, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker).foregroundStyle(Theme.muted).frame(minWidth: 12, alignment: .leading)
            inline(text)
        }
        .padding(.leading, CGFloat(level) * 18)
    }

    private func inline(_ text: String, font: Font = .body, color: Color? = nil) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var s = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        // bold reads in full ink, as on desktop
        for run in s.runs where run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true {
            s[run.range].foregroundColor = Theme.ink
        }
        return Text(s).font(font).foregroundStyle(color ?? self.color)
    }

    private func topSpace(_ block: MarkdownBlock, first: Bool) -> CGFloat {
        guard !first, case .heading(let level, _) = block else { return 0 }
        return level == 1 ? 14 : 12
    }
}

#Preview("Markdown") {
    ScrollView {
        MarkdownView(markdown: "## Decisions\n- Ship on **Thursday**\n  - after review\n1. Write the post\n- [x] Done thing\n\nA closing line.", color: Theme.written)
            .padding()
    }
}
