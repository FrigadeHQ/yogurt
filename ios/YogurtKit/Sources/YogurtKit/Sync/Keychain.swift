import Foundation
import Security

/// What pairing leaves on the phone: its own static key, and which computer it trusts.
public struct Pairing: Codable, Sendable, Equatable {
    public var phonePrivateKey: Data
    /// sent in pairDone, so the desktop can tell this phone from an earlier one
    public var phoneId: String
    public var desktopId: String
    public var desktopName: String
    public var desktopKey: Data

    public init(phonePrivateKey: Data, phoneId: String, desktopId: String, desktopName: String, desktopKey: Data) {
        self.phonePrivateKey = phonePrivateKey; self.phoneId = phoneId; self.desktopId = desktopId
        self.desktopName = desktopName; self.desktopKey = desktopKey
    }
}

/// Where the pairing is kept. The app uses the Keychain; tests keep it in memory.
public protocol PairingVault: AnyObject, Sendable {
    func load() -> Pairing?
    func save(_ pairing: Pairing) throws
    func delete()
}

public struct KeychainError: Error, Equatable { public let status: OSStatus }

/// One generic-password item, readable after the first unlock (so sync works with the screen locked) and never
/// copied to another device or a backup.
public final class KeychainVault: PairingVault {
    private let service: String

    public init(service: String = "chat.yogurt.pairing") { self.service = service }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "pairing",
         kSecUseDataProtectionKeychain as String: true]
    }

    public func load() -> Pairing? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        // anything but found (e.g. read before the first unlock) also comes back nil; the engine reads it again on
        // the next foreground while it has no pairing
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: data)
    }

    public func save(_ pairing: Pairing) throws {
        delete()
        var q = query
        q[kSecValueData as String] = try JSONEncoder().encode(pairing)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete() { SecItemDelete(query as CFDictionary) }
}

/// For tests and previews.
public final class MemoryVault: PairingVault, @unchecked Sendable {
    private let lock = NSLock()
    private var pairing: Pairing?
    public init(_ pairing: Pairing? = nil) { self.pairing = pairing }
    public func load() -> Pairing? { lock.lock(); defer { lock.unlock() }; return pairing }
    public func save(_ pairing: Pairing) throws { lock.lock(); self.pairing = pairing; lock.unlock() }
    public func delete() { lock.lock(); pairing = nil; lock.unlock() }
}
