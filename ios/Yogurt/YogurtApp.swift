import LocalAuthentication
import SwiftUI
import UIKit
import YogurtKit

@main
struct YogurtApp: App {
    @State private var model = AppModel.open()

    var body: some Scene {
        WindowGroup {
            Group {
                if let model {
                    RootView().environment(model)
                } else {
                    Text(S.storeFailed).foregroundStyle(Theme.muted).multilineTextAlignment(.center).padding(32)
                }
            }
            .tint(Theme.accent)
        }
    }
}

/// The phone's copy of the meetings and whatever keeps it in sync. One per app, on the main actor like the Store.
@MainActor @Observable
final class AppModel {
    let store: Store
    let storeFolder: URL
    /// the real sync with the paired computer
    let sync: SyncEngine
    /// DEBUG only: backs "Try with sample meetings" and the screenshot launch arguments
    let preview: PreviewSyncEngine?

    /// What the screens talk to: the preview while it is showing something, else the real engine.
    var engine: any SyncEngineProtocol {
        if let preview, preview.status != .notPaired || !preview.discovered.isEmpty { return preview }
        return sync
    }

    init(store: Store, storeFolder: URL, sync: SyncEngine, preview: PreviewSyncEngine?) {
        self.store = store; self.storeFolder = storeFolder; self.sync = sync; self.preview = preview
    }

    static func open() -> AppModel? {
        let folder = URL.applicationSupportDirectory.appending(path: "Yogurt", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let store = try? Store(url: folder.appending(path: "yogurt.sqlite")) else { return nil }
        var config = SyncConfig()
        config.appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        config.phoneName = UIDevice.current.name
        let sync = SyncEngine(store: store, vault: KeychainVault(), network: LiveNetwork(), config: config)
        #if DEBUG
        let preview: PreviewSyncEngine? = PreviewSyncEngine(store: store)
        #else
        let preview: PreviewSyncEngine? = nil
        #endif
        let model = AppModel(store: store, storeFolder: folder, sync: sync, preview: preview)
        #if DEBUG
        model.applyLaunchArguments()
        #endif
        return model
    }

    #if DEBUG
    /// Launch arguments for checking screens in the simulator, e.g. `-sample YES -previewStatus offline`.
    private func applyLaunchArguments() {
        guard let preview else { return }
        let d = UserDefaults.standard
        if d.bool(forKey: "sample"), !preview.showingSamples { preview.loadSamples() }
        if d.bool(forKey: "previewComputer") {
            preview.showDiscovered([PreviewSyncEngine.demoComputer, DiscoveredDesktop(id: "imac", name: "Studio iMac", pairing: false)])
        }
        switch d.string(forKey: "previewStatus") {
        case "offline": preview.show(.offline(PreviewSyncEngine.computerName, lastSync: Date().addingTimeInterval(-7200)))
        case "syncing": preview.show(.connected(PreviewSyncEngine.computerName, syncing: 12))
        case "searching": preview.show(.searching)
        case "error": preview.show(.error("This computer doesn't recognise this iPhone any more. Pair again."))
        default: break
        }
    }
    #endif

    /// Queues an edit for the computer and lets sync send it.
    func send(_ op: Op) {
        try? store.enqueue(PendingOp(op))
        Task { await engine.syncNow() }
    }

    /// Bytes of everything Yogurt keeps on this iPhone.
    func spaceUsed() -> Int64 {
        let files = FileManager.default.enumerator(at: storeFolder, includingPropertiesForKeys: [.totalFileAllocatedSizeKey])
        var total: Int64 = 0
        while let url = files?.nextObject() as? URL {
            total += Int64((try? url.resourceValues(forKeys: [.totalFileAllocatedSizeKey]))?.totalFileAllocatedSize ?? 0)
        }
        return total
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var phase
    @AppStorage("lockWithFaceID") private var lockWithFaceID = false
    @State private var locked = UserDefaults.standard.bool(forKey: "lockWithFaceID")

    var body: some View {
        ZStack {
            if model.engine.status == .notPaired {
                PairingView().transition(.opacity)
            } else {
                HomeView().transition(.opacity)
            }
            if locked && lockWithFaceID { LockView { locked = false }.transition(.opacity) }
        }
        .animation(.easeOut(duration: 0.24), value: model.engine.status == .notPaired)
        .background(Theme.bg)
        .onChange(of: phase, initial: true) { _, now in
            // sync runs only while Yogurt is on screen; a brief inactive (Control Centre) keeps the connection
            if now == .active { model.sync.setForeground(true) }
            if now == .background { locked = true; model.sync.setForeground(false) }
        }
    }
}

/// Covers the meetings until Face ID (or the passcode) says it's the owner.
struct LockView: View {
    let unlocked: () -> Void
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock").font(.system(size: 34, weight: .light)).foregroundStyle(Theme.muted)
            Text(S.locked).font(Theme.brand(26)).foregroundStyle(Theme.heading)
            Button(S.unlock, action: unlock).buttonStyle(PrimaryButtonStyle())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .task { await authenticate() }
    }

    private func unlock() { Task { await authenticate() } }

    private func authenticate() async {
        let ok = (try? await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: S.unlockReason)) ?? false
        if ok { unlocked() }
    }
}
