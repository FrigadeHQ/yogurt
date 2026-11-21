import SwiftUI
import YogurtKit

enum Route: Hashable {
    case meeting(String)
    case search
}

/// Meetings by day, newest first, with the connection always showing at the top.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var path: [Route] = []
    @State private var folder: String?
    @State private var showSettings = false
    @State private var showRecordingSoon = false

    var body: some View {
        NavigationStack(path: $path) {
            list
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .meeting(let id): NoteView(meetingId: id)
                    case .search: SearchView(open: { path.append(.meeting($0)) })
                    }
                }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .alert(S.recordingSoonTitle, isPresented: $showRecordingSoon) {
            Button(S.ok, role: .cancel) {}
        } message: { Text(S.recordingSoonBody) }
        .onAppear(perform: applyLaunch)
    }

    private var list: some View {
        let _ = model.engine.revision
        let folders = model.store.folders()
        let shownFolder = folders.contains { $0.id == folder } ? folder : nil
        let meetings = model.store.meetings(folder: shownFolder)
        let filed = shownFolder == nil ? folderMap(folders) : [:]
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(S.yourMeetings)
                    .font(Theme.brand(32, relativeTo: .largeTitle))
                    .foregroundStyle(Theme.heading)
                    .padding(.top, 6)
                if !folders.isEmpty {
                    FolderFilter(folders: folders, selected: shownFolder) { picked in
                        withAnimation(.easeOut(duration: 0.18)) { folder = picked }
                    }
                    .padding(.top, 14)
                }
                if meetings.isEmpty {
                    EmptyMeetings(inFolder: shownFolder != nil).padding(.top, 72)
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
                                    MeetingRow(meeting: m, folders: filed[m.id] ?? [])
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
            StatusPill(status: model.engine.status) { showSettings = true }
                .layoutPriority(1)
            Spacer(minLength: 4)
            IconButton(symbol: "magnifyingglass", label: S.search) { path.append(.search) }
            IconButton(symbol: "gearshape", label: S.settings) { showSettings = true }
        }
        .padding(.leading, 16).padding(.trailing, 8)
        .padding(.vertical, 6)
    }

    private var recordButton: some View {
        Button { showRecordingSoon = true } label: {
            Label(S.record, systemImage: "mic.fill").padding(.horizontal, 6)
        }
        .buttonStyle(PrimaryButtonStyle())
        .shadow(color: Theme.primary.opacity(0.28), radius: 14, y: 6)
        .padding(.bottom, 12)
        .accessibilityIdentifier("record")
    }

    private func folderMap(_ folders: [Folder]) -> [String: [Folder]] {
        var out: [String: [Folder]] = [:]
        for f in folders { for m in model.store.meetings(folder: f.id) { out[m.id, default: []].append(f) } }
        return out
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
        if let id = d.string(forKey: "openMeeting"), path.isEmpty { path = [.meeting(id)] }
        if d.string(forKey: "openSearch") != nil, path.isEmpty { path = [.search] }
        if d.bool(forKey: "openSettings") { showSettings = true }
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
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(Theme.ink)
                .frame(width: 38, height: 40)
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
    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: inFolder ? "folder" : "doc.text")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(Theme.written)
                .frame(width: 64, height: 64)
                .background(Theme.float, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.line))
                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.line.opacity(0.45)).padding(5))
                .shadow(color: .black.opacity(0.06), radius: 12, y: 8)
                .padding(.bottom, 16)
            Text(inFolder ? S.emptyFolder : S.emptyTitle)
                .font(.headline)
                .foregroundStyle(Theme.heading)
            if !inFolder {
                Text(S.emptyBody)
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
