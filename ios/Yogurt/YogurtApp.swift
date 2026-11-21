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

/// One meetings file: the Store the main actor writes to, and a second connection that reads off the main thread.
@MainActor final class Library {
    let store: Store
    let reader: StoreReader
    let folder: URL

    init(folder: URL) throws {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appending(path: "yogurt.sqlite")
        store = try Store(url: url)
        // opened after the writer, which creates the file
        reader = try StoreReader(url: url)
        self.folder = folder
    }

    /// Bytes of everything kept in the folder. Walks the files, so call it off the main thread.
    nonisolated static func spaceUsed(in folder: URL) -> Int64 {
        let files = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.totalFileAllocatedSizeKey])
        var total: Int64 = 0
        while let url = files?.nextObject() as? URL {
            total += Int64((try? url.resourceValues(forKeys: [.totalFileAllocatedSizeKey]))?.totalFileAllocatedSize ?? 0)
        }
        return total
    }
}

/// Reads for the screens on their own SQLite connection, so a long transcript or a search never holds up scrolling.
/// The file is in WAL mode, so these reads see every write the main Store has committed.
actor StoreReader {
    private let store: Store

    init(url: URL) throws { store = try Store(url: url) }

    struct Note: Sendable {
        var meeting: Meeting?
        var notes: Notes?
        var folders: [Folder]
        var inFolders: [String]
    }

    struct Found: Sendable, Identifiable {
        var hit: SearchHit
        var startedAt: Date?
        var id: String { hit.id }
    }

    func note(_ id: String) -> Note {
        Note(meeting: store.meeting(id), notes: store.notes(id), folders: store.folders(), inFolders: store.folderIds(of: id))
    }

    func segments(_ id: String) -> [Segment] { store.segments(id) }

    func search(_ query: String, limit: Int) -> [Found] {
        store.search(query, limit: limit).map { Found(hit: $0, startedAt: store.meeting($0.meetingId)?.startedAt) }
    }
}

/// The phone's meetings and whatever keeps them in sync. One per app, on the main actor like the Store.
@MainActor @Observable
final class AppModel {
    /// the real meetings
    let library: Library
    /// the real sync with the paired computer
    let sync: SyncEngine
    #if DEBUG
    /// "Try with sample meetings" and the screenshot launch arguments, in a file of their own
    let preview: PreviewSyncEngine
    let samples: Library
    #endif

    /// What the screens talk to: the preview while it is showing something, else the real engine.
    var engine: any SyncEngineProtocol {
        #if DEBUG
        if previewing { return preview }
        #endif
        return sync
    }

    /// The meetings the screens show: the sample file while samples are on.
    var store: Store { current.store }
    var reader: StoreReader { current.reader }
    var storeFolder: URL { current.folder }

    private var current: Library {
        #if DEBUG
        if previewing { return samples }
        #endif
        return library
    }

    #if DEBUG
    private var previewing: Bool { preview.status != .notPaired || !preview.discovered.isEmpty }

    init(library: Library, sync: SyncEngine, preview: PreviewSyncEngine, samples: Library) {
        self.library = library; self.sync = sync; self.preview = preview; self.samples = samples
    }
    #else
    init(library: Library, sync: SyncEngine) {
        self.library = library; self.sync = sync
    }
    #endif

    static func open() -> AppModel? {
        let support = URL.applicationSupportDirectory
        guard let library = try? Library(folder: support.appending(path: "Yogurt", directoryHint: .isDirectory)) else { return nil }
        var config = SyncConfig()
        config.appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        config.phoneName = UIDevice.current.name
        let sync = SyncEngine(store: library.store, vault: KeychainVault(), network: LiveNetwork(), config: config)
        #if DEBUG
        guard let samples = try? Library(folder: support.appending(path: "Yogurt samples", directoryHint: .isDirectory)) else { return nil }
        let model = AppModel(library: library, sync: sync, preview: PreviewSyncEngine(store: samples.store), samples: samples)
        model.applyLaunchArguments()
        return model
        #else
        return AppModel(library: library, sync: sync)
        #endif
    }

    #if DEBUG
    /// Launch arguments for checking screens in the simulator, e.g. `-sample YES -previewStatus offline`.
    private func applyLaunchArguments() {
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

    /// Goes up when sync lands something or the phone itself changes the Store; screens read again when it does.
    var revision: Int { engine.revision &+ edits }
    private var edits = 0

    /// An edit made on this iPhone is in the Store: show it everywhere now, even with no computer to sync with.
    func edited() { edits &+= 1 }

    /// Queues an edit for the computer and lets sync send it.
    func send(_ op: Op) {
        try? store.enqueue(PendingOp(op))
        edited()
        Task { await engine.syncNow() }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var phase
    /// read once: onboarding marks itself seen as soon as it starts, and stays up until it's finished
    @State private var onboarding = !UserDefaults.standard.bool(forKey: "onboarded")
    @State private var lock = LockController()

    var body: some View {
        ZStack {
            if onboarding {
                OnboardingView {
                    UserDefaults.standard.set(true, forKey: "onboarded")
                    withAnimation(.easeOut(duration: 0.3)) { onboarding = false }
                }
                .transition(.opacity)
            } else {
                HomeView().transition(.opacity)
            }
        }
        .background(Theme.bg)
        // VoiceOver can't read the meetings behind the lock
        .accessibilityHidden(lock.showing)
        .onAppear { lock.attach() }
        .onChange(of: phase, initial: true) { _, now in
            lock.phaseChanged(now)
            // sync runs only while Yogurt is on screen; a brief inactive (Control Centre) keeps the connection
            if now == .active { model.sync.setForeground(true) }
            if now == .background { model.sync.setForeground(false) }
        }
    }
}

/// The Face ID lock, in a window of its own above everything, sheets included. While Yogurt isn't the active app
/// (the app switcher, Control Centre) a plain cover hides the meetings; after the background it asks for Face ID.
@MainActor @Observable
final class LockController {
    private(set) var locked = false
    private(set) var covered = false
    private(set) var failure: String?
    @ObservationIgnored private var asked = false
    @ObservationIgnored private var window: UIWindow?

    /// The toggle is on and this iPhone can check its owner (a passcode is set). Without one the lock could never open.
    var enabled: Bool { UserDefaults.standard.bool(forKey: "lockWithFaceID") && LockController.available }
    var showing: Bool { enabled && (locked || covered) }

    static var available: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }

    init() { locked = enabled }

    func attach() {
        guard window == nil,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let w = UIWindow(windowScene: scene)
        w.windowLevel = .alert + 1
        let host = UIHostingController(rootView: LockLayer(lock: self))
        // opaque from the first frame, so the app switcher never catches it half drawn
        host.view.backgroundColor = UIColor(Theme.bg)
        w.backgroundColor = UIColor(Theme.bg)
        w.rootViewController = host
        w.isHidden = true
        window = w
        update()
    }

    func phaseChanged(_ phase: ScenePhase) {
        // no scene yet on the first appear: try again now
        attach()
        switch phase {
        case .active:
            covered = false
            if locked && enabled && !asked { asked = true; Task { await authenticate() } }
        case .inactive:
            // the app switcher takes its picture now, so the cover goes up before it
            if enabled { covered = true }
        case .background:
            if enabled { locked = true; covered = true; asked = false; failure = nil }
        @unknown default: break
        }
        if !enabled { locked = false; covered = false }
        update()
    }

    func authenticate() async {
        failure = nil
        do {
            if try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: S.unlockReason) { locked = false }
        } catch let e as LAError where e.code == .userCancel || e.code == .systemCancel || e.code == .appCancel {
            // they chose not to; the Unlock button stays
        } catch {
            failure = S.unlockFailed
        }
        update()
    }

    private func update() {
        guard let window else { return }
        let hidden = !showing
        guard window.isHidden != hidden else { return }
        window.isHidden = hidden
        if hidden { window.windowScene?.windows.first { $0 !== window }?.makeKey() } else { window.makeKey() }
    }
}

/// What the lock window shows: a plain cover while Yogurt is in the switcher, the Unlock screen once it's locked.
struct LockLayer: View {
    let lock: LockController
    var body: some View {
        ZStack {
            if lock.showing {
                Theme.bg.ignoresSafeArea()
                if lock.locked {
                    LockView(failure: lock.failure) { Task { await lock.authenticate() } }
                } else {
                    Image("Mark").resizable().frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .accessibilityHidden(true)
                }
            }
        }
        .animation(.easeOut(duration: 0.18), value: lock.locked)
        .tint(Theme.accent)
    }
}

/// Covers the meetings until Face ID (or the passcode) says it's the owner.
struct LockView: View {
    let failure: String?
    let unlock: () -> Void
    @ScaledMetric(relativeTo: .largeTitle) private var icon: CGFloat = 34

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock").font(.system(size: icon, weight: .light)).foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
            Text(S.locked).font(Theme.brand(26)).foregroundStyle(Theme.heading)
            Button(S.unlock, action: unlock).buttonStyle(PrimaryButtonStyle())
            if let failure {
                Text(failure).font(.subheadline).foregroundStyle(Theme.danger).multilineTextAlignment(.center)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .accessibilityAddTraits(.isModal)
    }
}
