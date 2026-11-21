import SwiftUI
import YogurtKit

enum Route: Hashable {
    case meeting(String)
    /// a meeting's transcript, scrolled to this moment (ms)
    case transcript(String, Int)
    case search
    /// Ask across meetings; with a meeting id, about that meeting first
    case ask(String?)
}

/// Meetings by day, newest first, with the connection always showing at the top.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [Route] = []
    @State private var folder: String?
    @State private var showSettings = false
    @State private var showConnect = false
    @State private var showRecord = false
    @Environment(\.scenePhase) private var phase
    @AppStorage("connectHintHidden") private var connectHintHidden = false

    var body: some View {
        NavigationStack(path: $path) {
            list
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .meeting(let id): NoteView(meetingId: id)
                    case .transcript(let id, let atMs): NoteView(meetingId: id, atMs: atMs)
                    case .search: SearchView(open: { path.append(.meeting($0)) })
                    case .ask(let id): AskView(meetingId: id)
                    }
                }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showConnect) { ConnectSheet() }
        .fullScreenCover(isPresented: $showRecord) {
            RecordView(saved: { path.append(.meeting($0)) }, preview: UserDefaults.standard.bool(forKey: "previewRecording"))
        }
        .onAppear(perform: applyLaunch)
        // recordings a crash left behind, and notes not written yet
        .task(id: phase) { if phase == .active { await PhoneDrafts.shared.resume(model: model) } }
    }

    private var list: some View {
        let _ = model.revision
        let folders = model.store.folders()
        let shownFolder = folders.contains { $0.id == folder } ? folder : nil
        let meetings = model.store.meetings(folder: shownFolder)
        let filed = shownFolder == nil ? folderMap(folders) : [:]
        let alone = model.engine.status == .notPaired
        let recordings = Dictionary(model.store.localRecordings().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(S.yourMeetings)
                    .font(Theme.brand(32, relativeTo: .largeTitle))
                    .foregroundStyle(Theme.heading)
                    .padding(.top, 6)
                if alone && !connectHintHidden {
                    ConnectHint(connect: { showConnect = true }, hide: {
                        withAnimation(.easeOut(duration: 0.2)) { connectHintHidden = true }
                    })
                    .padding(.top, 16)
                    .transition(.opacity)
                }
                if !folders.isEmpty {
                    FolderFilter(folders: folders, selected: shownFolder) { picked in
                        withAnimation(.easeOut(duration: 0.18)) { folder = picked }
                    }
                    .padding(.top, 14)
                }
                if meetings.isEmpty {
                    EmptyMeetings(inFolder: shownFolder != nil, alone: alone).padding(.top, alone && !connectHintHidden ? 48 : 72)
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(days(meetings), id: \.label) { day in
                            Text(day.label)
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(Theme.muted)
                                .padding(.top, 24).padding(.bottom, 4)
                                .accessibilityAddTraits(.isHeader)
                            ForEach(day.meetings) { m in
                                NavigationLink(value: Route.meeting(m.id)) {
                                    MeetingRow(meeting: m, folders: filed[m.id] ?? [], detail: PhoneDrafts.shared.homeDetail(for: m, recordings: recordings, model: model))
                                }
                                .buttonStyle(RowButtonStyle())
                                .padding(.horizontal, -8)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 110)
        }
        .scrollIndicators(.hidden)
        .background(Theme.bg)
        .refreshable { await model.engine.syncNow() }
        .safeAreaBar(edge: .top) { header }
        .overlay(alignment: .bottom) { recordButton }
    }

    private var header: some View {
        HStack(spacing: 0) {
            // not paired: the pill is the way to connect; otherwise it opens the connection in Settings
            StatusPill(status: model.engine.status) {
                if model.engine.status == .notPaired { showConnect = true } else { showSettings = true }
            }
                .layoutPriority(1)
            Spacer(minLength: 4)
            IconButton(symbol: "bubble.left.and.text.bubble.right", label: S.ask) { path.append(.ask(nil)) }
                .accessibilityIdentifier("ask")
            IconButton(symbol: "magnifyingglass", label: S.search) { path.append(.search) }
            IconButton(symbol: "gearshape", label: S.settings) { showSettings = true }
        }
        .padding(.leading, 16).padding(.trailing, 8)
        .padding(.vertical, 6)
    }

    private var recordButton: some View {
        Button { showRecord = true } label: {
            Label(S.record, systemImage: "mic.fill").padding(.horizontal, 6)
        }
        .buttonStyle(PrimaryButtonStyle())
        .shadow(color: Theme.primary.opacity(0.28), radius: 14, y: 6)
        .padding(.bottom, 12)
        .accessibilityIdentifier("record")
    }

    /// every meeting's folders, from one read
    private func folderMap(_ folders: [Folder]) -> [String: [Folder]] {
        let byId = Dictionary(folders.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return model.store.memberships().mapValues { $0.compactMap { byId[$0] } }
    }

    private func days(_ meetings: [Meeting]) -> [(label: String, meetings: [Meeting])] {
        var out: [(label: String, meetings: [Meeting])] = []
        for m in meetings {
            let label = Format.day(m.startedAt)
            if out.last?.label == label { out[out.count - 1].meetings.append(m) } else { out.append((label, [m])) }
        }
        return out
    }

    private func applyLaunch() {
        #if DEBUG
        let d = UserDefaults.standard
        if let id = d.string(forKey: "openMeeting"), path.isEmpty {
            path = [d.object(forKey: "openAtMs") != nil ? .transcript(id, d.integer(forKey: "openAtMs")) : .meeting(id)]
        }
        if d.string(forKey: "openSearch") != nil, path.isEmpty { path = [.search] }
        if d.object(forKey: "openAsk") != nil, path.count <= 1 { path.append(.ask(path.isEmpty ? nil : d.string(forKey: "openMeeting"))) }
        if d.bool(forKey: "openSettings") { showSettings = true }
        if d.bool(forKey: "openConnect") { showConnect = true }
        if d.bool(forKey: "openRecord") { showRecord = true }
        if let f = d.string(forKey: "openFolder") { folder = f }
        #endif
    }
}

struct IconButton: View {
    let symbol: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.body)
                .foregroundStyle(Theme.ink)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// All meetings, or one folder's.
struct FolderFilter: View {
    let folders: [Folder]
    let selected: String?
    let pick: (String?) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                chip(S.allMeetings, id: nil)
                ForEach(folders) { chip($0.name, id: $0.id) }
            }
            .padding(.horizontal, 20)
        }
        .scrollIndicators(.hidden)
        .padding(.horizontal, -20)
    }

    private func chip(_ name: String, id: String?) -> some View {
        let on = selected == id
        return Button { pick(id) } label: {
            HStack(spacing: 6) {
                if id != nil { Circle().fill(Theme.accent).frame(width: 6, height: 6) }
                Text(name)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(on ? Theme.ink : Theme.written)
            .padding(.horizontal, 13)
            .frame(height: 34)
            .background(on ? Theme.selected : .clear, in: Capsule())
            .overlay(Capsule().strokeBorder(on ? .clear : Theme.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// desktop's empty library: a soft tile, a title and one line
struct EmptyMeetings: View {
    let inFolder: Bool
    var alone = false
    @ScaledMetric(relativeTo: .title) private var tile: CGFloat = 64
    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: inFolder ? "folder" : "doc.text")
                .font(.title.weight(.light))
                .foregroundStyle(Theme.written)
                .frame(width: tile, height: tile)
                .background(Theme.float, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.line))
                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.line.opacity(0.45)).padding(5))
                .shadow(color: .black.opacity(0.06), radius: 12, y: 8)
                .padding(.bottom, 16)
            Text(inFolder ? S.emptyFolder : S.emptyTitle)
                .font(.headline)
                .foregroundStyle(Theme.heading)
            if !inFolder {
                Text(alone ? S.emptyBodyAlone : S.emptyBody)
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }
}

/// Home's quiet nudge while the phone has no computer: Connect, or put it away for good.
struct ConnectHint: View {
    let connect: () -> Void
    let hide: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "laptopcomputer")
                .font(.body)
                .foregroundStyle(Theme.art)
                .frame(width: 36, height: 36)
                .background(Theme.artSoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .accessibilityHidden(true)
            Text(S.connectHint)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            Button(S.connect, action: connect)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.accent)
                .frame(minHeight: 44)
                .accessibilityIdentifier("connect-hint")
            Button(action: hide) {
                Image(systemName: "xmark").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                    .frame(minWidth: 32, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(S.hide)
        }
        .padding(.leading, 12).padding(.trailing, 6)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
