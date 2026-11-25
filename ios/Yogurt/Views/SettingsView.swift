import SwiftUI
import YogurtKit

/// The computer (or connecting one), the permissions, the Face ID lock, and how much the phone keeps.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @AppStorage("lockWithFaceID") private var lockWithFaceID = false
    /// empty: the iPhone's language
    @AppStorage(SpokenLanguage.defaultsKey) private var spoken = ""
    @State private var confirmUnpair = false
    @State private var syncing = false
    @State private var connecting = false
    @State private var space: Int64?
    @State private var access: [Permission: Permission.Access] = [:]
    @State private var lockAvailable = LockController.available
    @ScaledMetric(relativeTo: .body) private var iconWidth: CGFloat = 24

    var body: some View {
        let revision = model.revision
        let status = model.engine.status
        let name = status.computerName
        NavigationStack {
            List {
                computer(status, name: name)
                spokenLanguage
                permissions
                Section {
                    Toggle(isOn: $lockWithFaceID) { rowLabel(S.faceIDLock, icon: "faceid") }
                        .tint(Theme.accent)
                        .disabled(!lockAvailable)
                } header: { sectionTitle(S.privacy) } footer: {
                    Text((lockAvailable ? S.faceIDFooter : S.faceIDNeedsPasscode) + " " + S.privacyNote)
                }
                .listRowBackground(Theme.bg)
                Section {
                    LabeledContent(S.meetingsOnPhone, value: "\(model.store.meetings().count)")
                    LabeledContent(S.spaceUsed, value: space.map(Format.bytes) ?? "–")
                } header: { sectionTitle(S.storage) }
                .listRowBackground(Theme.bg)
                .listRowSeparator(.hidden)
                #if DEBUG
                if model.preview.showingSamples {
                    Section { Text(S.sampleOn).font(.footnote).foregroundStyle(Theme.muted) }
                        .listRowBackground(Theme.card)
                }
                #endif
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(20)
            .environment(\.defaultMinListRowHeight, 50)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .tint(Theme.accent)
            .navigationTitle(S.settings)
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) { SheetHeader(title: S.settings) }
            .confirmationDialog(name.map(S.unpairTitle) ?? S.unpairTitleNoName, isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button(S.unpair, role: .destructive) { model.engine.unpair(); AskSession.shared.clear(); dismiss() }
                Button(S.cancel, role: .cancel) {}
            } message: {
                let unsent = model.store.unsentEdits()
                Text(unsent > 0 ? S.unpairBody + "\n\n" + S.unpairUnsent(unsent) : S.unpairBody)
            }
            .sheet(isPresented: $connecting) { ConnectSheet() }
        }
        // the folder walk reads every file's size, so it runs off the main thread
        .task(id: revision) {
            let folder = model.storeFolder
            space = await Task.detached(priority: .utility) { Library.spaceUsed(in: folder) }.value
        }
        .onAppear(perform: recheck)
        .onChange(of: phase) { _, now in if now == .active { recheck() } }
    }

    @ViewBuilder private func computer(_ status: ConnectionStatus, name: String?) -> some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: status == .notPaired ? "iphone" : "laptopcomputer")
                    .font(.body)
                    .foregroundStyle(Theme.written)
                    .frame(width: iconWidth)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    if status == .notPaired {
                        Text(S.onPhoneOnly).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                    } else {
                        Text(name ?? S.computer).font(.headline).foregroundStyle(Theme.ink)
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            Text(status.label(now: context.date))
                                .font(.footnote)
                                .foregroundStyle(isError(status) ? Theme.danger : Theme.muted)
                        }
                    }
                }
            }
            .padding(.vertical, 6)
            if status == .notPaired {
                Button { connecting = true } label: {
                    rowLabel(S.connectComputer, icon: "link", color: Theme.accent)
                }
                    .accessibilityIdentifier("settings-connect")
            } else {
                Button {
                    syncing = true
                    Task { await model.engine.syncNow(); syncing = false }
                } label: {
                    HStack {
                        rowLabel(S.syncNow, icon: "arrow.triangle.2.circlepath", color: Theme.accent)
                        Spacer()
                        if syncing { ProgressView().controlSize(.small) }
                    }
                }
                .disabled(syncing)
                Button(role: .destructive) { confirmUnpair = true } label: {
                    rowLabel(S.unpair, icon: "minus.circle", color: .red, iconColor: .red)
                }
            }
        } header: { sectionTitle(S.computer) } footer: {
            if status == .notPaired { Text(S.connectFooter) }
        }
        .listRowBackground(Theme.card)
        .listRowSeparator(.hidden)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .textCase(.uppercase)
            .tracking(0.6)
            .foregroundStyle(Theme.muted)
    }

    private func rowLabel(_ title: String, icon: String, color: Color = Theme.ink, iconColor: Color = Theme.muted) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(iconColor)
                .frame(width: iconWidth)
                .accessibilityHidden(true)
            Text(title).foregroundStyle(color)
        }
    }

    private var spokenLanguage: some View {
        let value = Spoken.selectionName(spoken)
        return Section {
            NavigationLink {
                SpokenLanguageList(selection: $spoken)
                    .navigationTitle(S.spokenLanguage)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar(.visible, for: .navigationBar)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "waveform.and.mic")
                        .foregroundStyle(Theme.muted)
                        .frame(width: iconWidth)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(S.spokenLanguage).foregroundStyle(Theme.ink)
                        Text(value)
                            .font(.subheadline)
                            .foregroundStyle(Theme.muted)
                    }
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 4)
                }
            }
            .accessibilityLabel(S.spokenLanguage)
            .accessibilityValue(value)
            .accessibilityIdentifier("settings-spoken-language")
        } footer: { Text(S.spokenFooter) }
        .listRowBackground(Theme.card)
    }

    private var permissions: some View {
        Section {
            ForEach(Permission.allCases, id: \.self) { p in
                let a = access[p] ?? p.access
                HStack(spacing: 12) {
                    rowLabel(p.name, icon: p.symbol)
                    Spacer()
                    switch a {
                    case .on:
                        Text(S.accessOn).foregroundStyle(Theme.muted)
                    case .off:
                        Button(S.openSettings) { Permission.openSettings() }.foregroundStyle(Theme.accent)
                    case .restricted:
                        Text(S.accessRestricted).foregroundStyle(Theme.muted)
                    case .notAsked:
                        Button(S.allow) { Task { _ = await p.request(); recheck() } }.foregroundStyle(Theme.accent)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityValue(a == .on ? S.accessOn : a == .off ? S.accessOff : a == .restricted ? S.accessRestricted : S.accessNotAsked)
            }
        } header: { sectionTitle(S.permissions) } footer: { Text(S.permissionsFooter) }
        .listRowBackground(Theme.bg)
        .listRowSeparator(.hidden)
    }

    /// Permissions and the passcode can change in the Settings app while Yogurt is open.
    private func recheck() {
        access = Dictionary(uniqueKeysWithValues: Permission.allCases.map { ($0, $0.access) })
        lockAvailable = LockController.available
        // the passcode was removed: the lock can't work, so the switch says so instead of showing On
        if !lockAvailable { lockWithFaceID = false }
    }

    private func isError(_ s: ConnectionStatus) -> Bool { if case .error = s { true } else { false } }
}
