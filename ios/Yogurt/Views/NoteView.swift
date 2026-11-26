import SwiftUI
import YogurtKit

/// One meeting: Transcript, My notes and Summary, as on desktop. My notes can be edited here; it saves as you type and
/// goes to the computer with the next sync.
struct NoteView: View {
    enum Tab: String, CaseIterable { case transcript, mine, summary }

    let meetingId: String
    /// opened from an Ask source: the transcript, at this moment (ms)
    var atMs: Int? = nil
    var trashed: (String) -> Void = { _ in }
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var tab: Tab?
    @State private var renaming = false
    @State private var confirmDeleteAudio = false
    @State private var newTitle = ""
    @State private var toast: String?
    @State private var toastTask: Task<Void, Never>?
    /// read off the main thread, again each time sync lands something
    @State private var loaded: StoreReader.Note?
    @State private var player = NotePlayer()
    /// Share audio was tapped: the audio is still coming from the computer, or being made into one file
    @State private var audioShare: AudioShare?

    enum AudioShare: Equatable { case waiting, preparing }

    var body: some View {
        let revision = model.revision
        // the computer coming into reach (or going) is when audio can be fetched
        let connected: Bool = { if case .connected = model.engine.status { true } else { false } }()
        Group {
            if let loaded {
                if let meeting = loaded.meeting {
                    content(meeting, loaded)
                } else {
                    Text(S.notFound).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                Color.clear
            }
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) { toastView }
        .task(id: revision) { loaded = await model.reader.note(meetingId) }
        .task(id: connected) { player.load(meetingId: meetingId, model: model, startAt: atMs) }
        // leaving the note ends its audio. Going to the background doesn't pause what is playing (the audio mode is on);
        // what isn't playing never starts.
        .onDisappear { player.stop() }
        // Share audio tapped while the audio was still coming: share it once it's here, or say why not
        .onChange(of: player.state) { _, now in
            guard audioShare == .waiting, let meeting = loaded?.meeting else { return }
            switch now {
            case .ready: shareAudio(meeting)
            case .downloading, .loading: break
            default: audioShare = nil; say(audioReason ?? S.shareFailed)
            }
        }
    }

    private func content(_ meeting: Meeting, _ loaded: StoreReader.Note) -> some View {
        let notes = loaded.notes
        let folders = loaded.folders
        let inFolders = folders.filter { loaded.inFolders.contains($0.id) }
        let shown = tab ?? defaultTab(notes)
        return ScrollViewReader { proxy in ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header(meeting, folders: inFolders)
                if meeting.trashedAt != nil { trashBanner }
                tabs(shown)
                Group {
                    switch shown {
                    case .summary: SummaryPane(notes: notes)
                    case .mine: MyNotesPane(meetingId: meetingId, latest: notes?.mine ?? "")
                    case .transcript: TranscriptPane(meetingId: meetingId, oneMic: meeting.oneMic,
                                                     atMs: tab == nil ? atMs : nil, proxy: proxy, player: player)
                    }
                }
                .padding(.top, 24)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        } }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            PlayerBar(player: player) { player.load(meetingId: meetingId, model: model) }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(S.ask, value: Route.ask(meetingId))
                    .accessibilityIdentifier("note-ask")
            }
            ToolbarItem(placement: .topBarTrailing) { menu(meeting, folders: folders, inFolders: inFolders) }
        }
        .alert(S.deleteAudioQuestion, isPresented: $confirmDeleteAudio) {
            Button(S.cancel, role: .cancel) {}
            Button(S.deleteAudio, role: .destructive) {
                do { try player.deleteAudio(meetingId: meetingId, model: model) }
                catch { say(S.deleteAudioFailed) }
            }
        } message: {
            let unsent = model.store.awaitsFirstUpload(meetingId)
            Text(unsent ? S.deleteAudioBody + "\n\n" + S.unsyncedAudioBody : S.deleteAudioBody)
        }
        .alert(S.renameTitle, isPresented: $renaming) {
            TextField(S.title, text: $newTitle)
            Button(S.save) {
                let title = Op.title(newTitle)
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
                .font(.largeTitle.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
                .foregroundStyle(Theme.heading)
                .onTapGesture { newTitle = m.title; renaming = true }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint(S.rename)
            Text([Format.day(m.startedAt), Format.time(m.startedAt), Format.duration(m)]
                .compactMap { $0 }.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
            if !m.attendees.isEmpty {
                Label(Format.people(m.attendees), systemImage: "person.2")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            if !folders.isEmpty {
                HStack(spacing: 6) { ForEach(folders) { MeetingFolderLabel(name: $0.name) } }.padding(.top, 2)
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

    private func tabs(_ shown: Tab) -> some View {
        HStack(spacing: 2) {
            ForEach(Tab.allCases, id: \.self) { t in
                Button(label(t)) {
                    withAnimation(.easeOut(duration: 0.18)) { tab = t }
                }
                .buttonStyle(MeetingTabStyle(selected: shown == t))
                .accessibilityAddTraits(shown == t ? .isSelected : [])
                .accessibilityIdentifier("tab-\(t.rawValue)")
            }
        }
        .padding(3)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
        .padding(.top, 20)
    }

    private func label(_ t: Tab) -> String {
        switch t {
        case .summary: S.summary
        case .mine: S.myNotes
        case .transcript: S.transcript
        }
    }

    private func defaultTab(_ notes: Notes?) -> Tab {
        if atMs != nil { return .transcript }
        // a phone recording opens on its notes being written
        if notes?.summary?.isEmpty == false || notes?.summarySource == .phoneDraft { return .summary }
        return .mine
    }

    private func menu(_ m: Meeting, folders: [Folder], inFolders: [Folder]) -> some View {
        Menu {
            shareItems(m)
            Divider()
            Button { newTitle = m.title; renaming = true } label: { Label(S.rename, systemImage: "pencil") }
            // folders are made on the computer: a phone on its own has none, so no menu that points there
            if model.engine.status.isPaired || !folders.isEmpty {
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
            }
            if player.canDeleteAudio || m.trashedAt == nil { Divider() }
            if player.canDeleteAudio {
                Button(S.deleteAudio, systemImage: "waveform.slash", role: .destructive) { confirmDeleteAudio = true }
                    .tint(Color(uiColor: .systemRed))
                    .disabled(audioShare != nil || model.sync.uploadingId == meetingId)
            }
            if m.trashedAt == nil {
                Button(S.moveToTrash, systemImage: "trash", role: .destructive) {
                    do { try model.send(Op(kind: .trash, meetingId: meetingId)) }
                    catch { say(S.notSaved); return }
                    trashed(meetingId)
                    dismiss()
                }
                .tint(Color(uiColor: .systemRed))
            }
        } label: {
            Image(systemName: "ellipsis").accessibilityLabel(S.more)
        }
        .accessibilityLabel(S.more)
        .accessibilityIdentifier("note-more")
    }

    // MARK: - Share

    /// Summary first, as on desktop; each makes a file and opens the share sheet. One that can't share says why.
    @ViewBuilder private func shareItems(_ m: Meeting) -> some View {
        let notes = loaded?.notes
        let hasNotes = notes?.summary?.isEmpty == false || notes?.mine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        Button { shareSummary(m) } label: {
            Label { Text(S.shareSummary); if !hasNotes { Text(S.nothingToShare) } } icon: { Image(systemName: "doc.text") }
        }
        .disabled(!hasNotes)
        .accessibilityIdentifier("share-summary")
        let hasTranscript = loaded?.hasTranscript == true
        Button { shareTranscript(m) } label: {
            Label { Text(S.shareTranscript); if !hasTranscript { Text(S.noTranscript) } } icon: { Image(systemName: "text.quote") }
        }
        .disabled(!hasTranscript)
        .accessibilityIdentifier("share-transcript")
        let reason = audioReason
        Button { shareAudio(m) } label: {
            Label { Text(S.shareAudio); if let reason { Text(reason) } } icon: { Image(systemName: "waveform") }
        }
        .disabled(reason != nil && !downloadingAudio || audioShare != nil)
        .accessibilityIdentifier("share-audio")
    }

    private var downloadingAudio: Bool { if case .downloading = player.state { true } else { false } }

    /// Why Share audio can't go now, in the player's words; nil when it can (or is on its way)
    private var audioReason: String? {
        switch player.state {
        case .ready: nil
        case .downloading: S.audioDownloading
        case .loading: S.audioPreparing
        case .nearby: S.audioShareNearby
        case .noAudio: S.audioNone
        case .failed(let message): message
        }
    }

    private func fileName(_ m: Meeting, suffix: String? = nil, ext: String) -> String {
        ShareExport.fileName(title: m.title, startedAt: m.startedAt, suffix: suffix, ext: ext, fallback: S.meeting)
    }

    private func shareSummary(_ m: Meeting) {
        // the Store's notes, so My notes typed a moment ago go too
        let notes = model.store.notes(meetingId) ?? loaded?.notes
        let text = ShareExport(meeting: m, labels: ShareFiles.labels).summary(summary: notes?.summary, mine: notes?.mine ?? "")
        do { ShareFiles.present([try ShareFiles.write(text, name: fileName(m, ext: "md"))]) } catch { say(S.shareFailed) }
    }

    private func shareTranscript(_ m: Meeting) {
        Task {
            let segments = await model.reader.segments(meetingId)
            guard !segments.isEmpty else { say(S.noTranscript); return }
            let text = ShareExport(meeting: m, labels: ShareFiles.labels).transcript(segments)
            do { ShareFiles.present([try ShareFiles.write(text, name: fileName(m, suffix: S.transcript, ext: "md"))]) } catch { say(S.shareFailed) }
        }
    }

    /// The audio the player has; still coming from the computer, it's shared as soon as it's here.
    private func shareAudio(_ m: Meeting) {
        guard player.isReady, !player.files.isEmpty else {
            if downloadingAudio { audioShare = .waiting }
            return
        }
        audioShare = .preparing
        let files = player.files, name = String(fileName(m, ext: "m4a").dropLast(4))
        Task {
            defer { audioShare = nil }
            do { ShareFiles.present([try await ShareFiles.audio(files, name: name)]) } catch { say(S.shareFailed) }
        }
    }

    /// A short line at the foot for 3 seconds; a second one starts the 3 seconds again rather than being cleared early.
    private func say(_ text: String) {
        withAnimation { toast = text }
        toastTask?.cancel()
        toastTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            withAnimation { toast = nil }
        }
    }

    private func change(_ op: Op) {
        do {
            if let message = try model.send(op) { say(message) }
        } catch { say(S.notSaved) }
    }

    @ViewBuilder private var toastView: some View {
        if let audioShare {
            HStack(spacing: 10) {
                if audioShare == .waiting, case .downloading(let p) = player.state {
                    ProgressView(value: p).tint(Theme.accent).frame(width: 80)
                    Text(S.audioDownloading)
                } else {
                    ProgressView().controlSize(.small)
                    Text(S.audioPreparing)
                }
            }
            .font(.footnote)
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.float, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.line))
            .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
            .padding(.bottom, 16).padding(.horizontal, 20)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityIdentifier("share-audio-progress")
        } else if let toast {
            NoteToast(text: toast)
        }
    }
}

struct NoteToast: View {
    let text: String

    var body: some View {
        Text(text)
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

// MARK: - Panes

struct SummaryPane: View {
    let notes: Notes?
    @Environment(AppModel.self) private var model
    var body: some View {
        if let summary = notes?.summary, !summary.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                if let notes, notes.summarySource == .phoneDraft {
                    let localOnly = model.store.staysOnPhone(notes.meetingId)
                    Label(model.engine.status.isPaired && !localOnly ? S.draftSummary : S.writtenHere, systemImage: "iphone")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
                MarkdownView(markdown: summary, color: Theme.written)
                    .lineSpacing(3)
            }
        } else if let notes, notes.summarySource == .phoneDraft {
            PhoneDraftNotice(meetingId: notes.meetingId)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text(S.noSummary).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                if model.engine.status.isPaired { Text(S.noSummaryBody).font(.subheadline).foregroundStyle(Theme.muted) }
            }
        }
    }
}

/// My notes, saved a second after typing stops (and on leaving or switching apps), as one queued edit for the computer.
struct MyNotesPane: View {
    let meetingId: String
    /// My notes as the Store has them now; a sync can change it while this is open
    let latest: String
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var phase
    @State private var text: String
    /// the text last read from or saved to the Store, so loading it again isn't taken for typing
    @State private var base: String
    @State private var state: SaveState = .saved
    @State private var saveTask: Task<Void, Never>?
    @FocusState private var focused: Bool

    enum SaveState { case saved, saving, failed }

    init(meetingId: String, latest: String) {
        self.meetingId = meetingId
        self.latest = latest
        _text = State(initialValue: latest)
        _base = State(initialValue: latest)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(S.myNotesPlaceholder, text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .focused($focused)
                .font(.body)
                .foregroundStyle(Theme.ink)
                .lineSpacing(4)
                .padding(14)
                .frame(maxWidth: .infinity, minHeight: 52, alignment: .topLeading)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 14))
                .accessibilityLabel(S.myNotes)
                .accessibilityIdentifier("my-notes")
            Text(stateLabel)
                .font(.caption)
                .foregroundStyle(state == .failed ? Theme.danger : Theme.muted)
                .contentTransition(.opacity)
        }
        .onChange(of: text) { _, new in if new != base { schedule() } }
        .onDisappear { if state == .saving { save() } }
        // leaving Yogurt (home swipe, a call, the lock) saves what's typed now, not a second later
        .onChange(of: phase) { _, now in if now != .active, state == .saving { save() } }
        // the computer's newer My notes arrived: show them, unless the person is typing (their save merges on the computer)
        .onChange(of: latest) { _, new in
            guard !focused, state == .saved, new != text else { return }
            base = new
            text = new
        }
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
        guard model.store.notes(meetingId)?.mine != text else { base = text; state = .saved; return }
        do {
            try model.store.editMine(meetingId: meetingId, text: text)
            model.edited()
            base = text
            state = .saved
            Task { await model.engine.syncNow() }
        } catch {
            state = .failed
        }
    }
}

struct TranscriptPane: View {
    let meetingId: String
    /// recorded on one iPhone in a room, without speaker labels
    var oneMic = false
    /// scrolls to the turn this moment falls in, once, and marks it
    var atMs: Int? = nil
    var proxy: ScrollViewProxy? = nil
    /// tapping a line plays from it, and the line playing is marked
    var player: NotePlayer? = nil
    @Environment(AppModel.self) private var model
    /// nil until read; a long transcript is read off the main thread
    @State private var segments: [Segment]?
    @State private var bubbles: [RoomBubble] = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scrolled = false

    var body: some View {
        let revision = model.revision
        Group {
            if let segments { lines(segments) } else { Color.clear.frame(height: 1) }
        }
        .task(id: revision) {
            let read = await model.reader.segments(meetingId)
            guard !Task.isCancelled else { return }
            if oneMic {
                bubbles = RoomBubble.group(read.map { .init(startMs: $0.startMs, endMs: $0.endMs, text: $0.text) })
            }
            segments = read
            if let atMs, !scrolled, let target = target(atMs) {
                // after the lines are laid out
                try? await Task.sleep(for: .milliseconds(80))
                guard !Task.isCancelled else { return }
                scrolled = true
                withAnimation(oneMic && reduceMotion ? nil : .easeOut(duration: 0.25)) { proxy?.scrollTo(target, anchor: .center) }
            }
        }
    }

    @ViewBuilder private func lines(_ segments: [Segment]) -> some View {
        if oneMic ? bubbles.isEmpty : segments.isEmpty {
            Text(S.noTranscript).font(.subheadline).foregroundStyle(Theme.muted)
        } else if oneMic {
            let position: Int? = if let player, player.touched, player.isReady { player.positionMs } else { atMs }
            let marked = position.flatMap { target($0) }
            LazyVStack(alignment: .leading, spacing: 5) {
                ForEach(bubbles) { bubble in
                    let play: (() -> Void)? = if let player, player.isReady, !player.blocked {
                        { player.playFrom(lineAt: bubble.startMs) }
                    } else { nil }
                    RoomTranscriptBubble(bubble: bubble, marked: bubble.id == marked, play: play)
                        .id(bubble.id)
                }
            }
        } else {
            let all = turns(segments)
            let starts = all.map(\.first.startMs)
            // the line playing, else the one an Ask source pointed at
            let markedIndex: Int? = {
                if let player, player.touched, player.isReady, let i = PlayerLogic.line(at: player.positionMs, starts: starts) { return all[i].first.index }
                return atMs.flatMap { ms in PlayerLogic.line(at: ms, starts: starts).map { all[$0].first.index } }
            }()
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(all, id: \.first.index) { turn in
                    let marked = markedIndex == turn.first.index
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(speaker(turn.first.speaker))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.ink)
                            Spacer(minLength: 8)
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
                    .padding(marked ? 10 : 0)
                    .background(marked ? Theme.accentSoft : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .padding(marked ? -10 : 0)
                    .contentShape(Rectangle())
                    .onTapGesture { if let player, player.isReady { player.playFrom(lineAt: turn.first.startMs) } }
                    .id(turn.first.index)
                }
            }
        }
    }

    /// the turn a moment falls in: the last one starting at or before it
    private func target(_ ms: Int) -> Int? {
        if oneMic { return (bubbles.last { $0.startMs <= ms } ?? bubbles.first)?.id }
        guard let segments else { return nil }
        let all = turns(segments)
        return (all.last { $0.first.startMs <= ms } ?? all.first)?.first.index
    }

    /// back-to-back lines from the same speaker read as one turn
    private func turns(_ segments: [Segment]) -> [(first: Segment, text: String)] {
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
            inline(text, font: level == 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .body.weight(.semibold), color: Theme.heading)
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
            .padding(.leading, indent(level))
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
        .padding(.leading, indent(level))
    }

    /// deep nesting stops indenting at six levels, so odd input can't push text off screen
    private func indent(_ level: Int) -> CGFloat { CGFloat(min(level, 6)) * 18 }

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
        return level == 1 ? 18 : 16
    }
}

#Preview("Markdown") {
    ScrollView {
        MarkdownView(markdown: "## Decisions\n- Ship on **Thursday**\n  - after review\n1. Write the post\n- [x] Done thing\n\nA closing line.", color: Theme.written)
            .padding()
    }
}
