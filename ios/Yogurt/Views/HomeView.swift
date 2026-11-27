import SwiftUI
import YogurtKit

enum Route: Hashable {
    case meeting(String)
    /// a meeting's transcript, scrolled to this moment (ms)
    case transcript(String, Int)
    /// a meeting's transcript where it says this (an Ask answer's claim from the notes); the notes when it doesn't
    case cited(String, String)
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

    var body: some View {
        NavigationStack(path: $path) {
            list
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .meeting(let id): NoteView(meetingId: id)
                    case .transcript(let id, let atMs): NoteView(meetingId: id, atMs: atMs)
                    case .cited(let id, let claim): NoteView(meetingId: id, claim: claim)
                    case .search: SearchView(open: { path.append(.meeting($0)) })
                    case .ask(let id): AskView(meetingId: id)
                    }
                }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showConnect) { ConnectSheet() }
        .fullScreenCover(isPresented: $showRecord) {
            RecordView(saved: { path.append(.meeting($0)) },
                       preview: UserDefaults.standard.bool(forKey: "previewRecording"))
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
        let alone = !model.engine.status.isPaired
        let recordings = Dictionary(model.store.localRecordings().map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !folders.isEmpty {
                    FolderFilter(folders: folders, selected: shownFolder) { picked in
                        withAnimation(.easeOut(duration: 0.18)) { folder = picked }
                    }
                    .padding(.top, 8)
                }
                if meetings.isEmpty {
                    EmptyMeetings(inFolder: shownFolder != nil, alone: alone).padding(.top, 72)
                } else {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(days(meetings), id: \.label) { day in
                            Text(day.label)
                                .font(.caption.weight(.semibold))
                                .textCase(.uppercase)
                                .tracking(0.6)
                                .foregroundStyle(Theme.muted)
                                .padding(.top, 22).padding(.bottom, 2)
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
        }
        .scrollIndicators(.hidden)
        .background(Theme.bg)
        .refreshable { await model.engine.syncNow() }
        .safeAreaBar(edge: .top) { header }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            recordButton
                .padding(.top, 16)
                .frame(maxWidth: .infinity)
                .background {
                    LinearGradient(stops: [.init(color: Theme.bg.opacity(0), location: 0),
                                           .init(color: Theme.bg, location: 0.4)],
                                   startPoint: .top, endPoint: .bottom)
                        .ignoresSafeArea(edges: .bottom)
                        .allowsHitTesting(false)
                }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    title.fixedSize()
                    Spacer(minLength: 8)
                    tools.fixedSize()
                }
                VStack(alignment: .leading, spacing: 0) { title; tools }
            }
            if model.engine.status.showsPill {
                StatusPill(status: model.engine.status) { showSettings = true }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .background(Theme.bg)
    }

    private var title: some View {
        Text(S.meetings)
            .font(.largeTitle.weight(.semibold))
            .foregroundStyle(Theme.heading)
            .accessibilityAddTraits(.isHeader)
    }

    private var tools: some View {
        HStack(spacing: 0) {
            Button { path.append(.ask(nil)) } label: {
                Text(S.ask)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Theme.card, in: Capsule())
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("ask")
            IconButton(symbol: "magnifyingglass", label: S.search) { path.append(.search) }
            IconButton(symbol: "gearshape", label: S.settings) { showSettings = true }
        }
    }

    private var recordButton: some View {
        Button { showRecord = true } label: {
            Label(S.record, systemImage: "mic.fill")
        }
        .buttonStyle(PrimaryButtonStyle())
        .padding(.horizontal, 20)
        .accessibilityIdentifier("record")
        .padding(.bottom, 12)
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
            Text(name)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(on ? Theme.accent : Theme.written)
            .padding(.horizontal, 13)
            .frame(minHeight: 32)
            .background(on ? Theme.accentSoft : Theme.card, in: Capsule())
            .frame(minHeight: 44)
            .contentShape(Rectangle())
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
                .background(Theme.card, in: Circle())
                .accessibilityHidden(true)
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
