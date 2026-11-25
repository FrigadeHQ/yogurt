import Foundation

/// Folders that hold copies of a meeting's audio: readable while the phone is locked only once a file was opened
/// before (a meeting goes on in a pocket), like the Recordings folder.
public enum PrivateFolder {
    /// Creates the folder, or fixes one an earlier install made. Safe to call at every launch.
    public static func make(_ url: URL, protection: FileProtectionType = .completeUnlessOpen) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: url, withIntermediateDirectories: true, attributes: protected(protection))
        // new files take the folder's protection; an older folder gets it now
        try? fm.setAttributes(protected(protection), ofItemAtPath: url.path)
    }

    /// Removes what's in the folder that hasn't been written or used for this long.
    public static func prune(_ url: URL, unusedFor: TimeInterval, now: Date = Date()) {
        let fm = FileManager.default
        let items = (try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for item in items {
            let used = (try? item.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if now.timeIntervalSince(used) > unusedFor { try? fm.removeItem(at: item) }
        }
    }

    /// Marks a file as just used, so `prune` keeps it.
    public static func touch(_ url: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    }

    private static func protected(_ p: FileProtectionType) -> [FileAttributeKey: Any] {
        #if os(iOS)
        [.protectionKey: p]
        #else
        [:]
        #endif
    }
}

/// The Keychain keeps a pairing after Yogurt is deleted. A fresh install (never onboarded) starts unpaired, so a
/// reinstalled app never syncs with a computer nobody paired it with this time.
public enum LeftoverPairing {
    public static func forget(defaults: UserDefaults = .standard, vault: PairingVault, protectedDataAvailable: Bool) {
        // before the first unlock the settings read as empty, which would look like a fresh install
        guard protectedDataAvailable, !defaults.bool(forKey: "onboarded") else { return }
        vault.delete()
    }
}
