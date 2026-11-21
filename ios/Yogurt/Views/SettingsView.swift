import SwiftUI
import YogurtKit

/// The paired computer and how sync is doing, the Face ID lock, and how much the phone keeps.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("lockWithFaceID") private var lockWithFaceID = false
    @State private var confirmUnpair = false
    @State private var syncing = false

    var body: some View {
        let _ = model.engine.revision
        let status = model.engine.status
        let name = status.computerName
        NavigationStack {
            List {
                Section(S.computer) {
                    HStack(spacing: 12) {
                        Image(systemName: "laptopcomputer")
                            .font(.system(size: 17))
                            .foregroundStyle(Theme.written)
                            .frame(width: 38, height: 38)
                            .background(Theme.control, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name ?? S.notPaired).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                            TimelineView(.periodic(from: .now, by: 60)) { context in
                                Text(status.label(now: context.date))
                                    .font(.footnote)
                                    .foregroundStyle(isError(status) ? Theme.danger : Theme.muted)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                    if status != .notPaired {
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
                }
                .listRowBackground(Theme.card)
                Section {
                    Toggle(isOn: $lockWithFaceID) { Label(S.faceIDLock, systemImage: "faceid") }
                        .tint(Theme.primary)
                } header: { Text(S.privacy) } footer: {
                    Text(S.faceIDFooter + " " + S.privacyNote)
                }
                .listRowBackground(Theme.card)
                Section(S.storage) {
                    LabeledContent(S.meetingsOnPhone, value: "\(model.store.meetings().count)")
                    LabeledContent(S.spaceUsed, value: Format.bytes(model.spaceUsed()))
                }
                .listRowBackground(Theme.card)
                if model.preview?.showingSamples == true {
                    Section { Text(S.sampleOn).font(.footnote).foregroundStyle(Theme.muted) }
                        .listRowBackground(Theme.card)
                }
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
        }
    }

    private func isError(_ s: ConnectionStatus) -> Bool { if case .error = s { true } else { false } }
}
