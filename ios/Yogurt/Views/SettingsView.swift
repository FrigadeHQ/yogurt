import SwiftUI
import YogurtKit

/// The computer (or connecting one), the permissions, the Face ID lock, and how much the phone keeps.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @AppStorage("lockWithFaceID") private var lockWithFaceID = false
    @State private var confirmUnpair = false
    @State private var syncing = false
    @State private var connecting = false
    @State private var space: Int64?
    @State private var access: [Permission: Permission.Access] = [:]
    @State private var lockAvailable = LockController.available
    @ScaledMetric(relativeTo: .body) private var tile: CGFloat = 38

    var body: some View {
        let revision = model.revision
        let status = model.engine.status
        let name = status.computerName
        NavigationStack {
            List {
                computer(status, name: name)
                permissions
                Section {
                    Toggle(isOn: $lockWithFaceID) { Label(S.faceIDLock, systemImage: "faceid") }
                        .tint(Theme.primary)
                        .disabled(!lockAvailable)
                } header: { Text(S.privacy) } footer: {
                    Text((lockAvailable ? S.faceIDFooter : S.faceIDNeedsPasscode) + " " + S.privacyNote)
                }
                .listRowBackground(Theme.card)
                Section(S.storage) {
                    LabeledContent(S.meetingsOnPhone, value: "\(model.store.meetings().count)")
                    LabeledContent(S.spaceUsed, value: space.map(Format.bytes) ?? "–")
                }
                .listRowBackground(Theme.card)
                #if DEBUG
                if model.preview.showingSamples {
                    Section { Text(S.sampleOn).font(.footnote).foregroundStyle(Theme.muted) }
                        .listRowBackground(Theme.card)
                }
                #endif
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .tint(Theme.accent)
            .navigationTitle(S.settings)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button(S.done) { dismiss() } }
            }
            .confirmationDialog(S.unpairTitle(name ?? S.computer.lowercased()), isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button(S.unpair, role: .destructive) { model.engine.unpair(); dismiss() }
                Button(S.cancel, role: .cancel) {}
            } message: { Text(S.unpairBody) }
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
                    .frame(width: tile, height: tile)
                    .background(Theme.control, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    if status == .notPaired {
                        Text(S.onPhoneOnly).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                    } else {
                        Text(name ?? S.computer).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            Text(status.label(now: context.date))
                                .font(.footnote)
                                .foregroundStyle(isError(status) ? Theme.danger : Theme.muted)
                        }
                    }
                }
            }
            .padding(.vertical, 2)
            if status == .notPaired {
                Button { connecting = true } label: { Text(S.connectComputer).foregroundStyle(Theme.accent) }
                    .accessibilityIdentifier("settings-connect")
            } else {
                Button {
                    syncing = true
                    Task { await model.engine.syncNow(); syncing = false }
                } label: {
                    HStack {
                        Text(S.syncNow).foregroundStyle(Theme.accent)
                        Spacer()
                        if syncing { ProgressView().controlSize(.small) }
                    }
                }
                .disabled(syncing)
                Button(role: .destructive) { confirmUnpair = true } label: {
                    Text(S.unpair).foregroundStyle(Theme.danger)
                }
            }
        } header: { Text(S.computer) } footer: {
            if status == .notPaired { Text(S.connectFooter) }
        }
        .listRowBackground(Theme.card)
    }

    private var permissions: some View {
        Section {
            ForEach(Permission.allCases, id: \.self) { p in
                let a = access[p] ?? p.access
                HStack(spacing: 12) {
                    Label(p.name, systemImage: p.symbol).foregroundStyle(Theme.ink)
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
        } header: { Text(S.permissions) } footer: { Text(S.permissionsFooter) }
        .listRowBackground(Theme.card)
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
