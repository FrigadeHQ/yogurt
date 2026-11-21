import Clibsodium
import Foundation

/// The initiator's state between `start` and `finish`. Single use: `finish` wipes the scalar in place,
/// whether it succeeds or not. Not thread-safe: use from one place at a time.
public final class CPaceSecret {
    let scalarStorage: SecureBytes
    let sid: Data, ya: Data, ada: Data
    private var used = false

    init(scalar: SecureBytes, sid: Data, ya: Data, ada: Data) {
        scalarStorage = scalar; self.sid = sid; self.ya = ya; self.ada = ada
    }

    func finish(yb: Data, adb: Data) throws -> Data {
        guard !used else { throw CryptoError.secretUsed }
        used = true
        defer { scalarStorage.wipe() }
        return try CPace.isk(sid: sid, k: CPace.scalarMultVfy(scalarStorage, yb), ya: ya, ada: ada, yb: yb, adb: adb)
    }
}

/// CPace on ristretto255 + SHA-512, initiator/responder setting, exactly as draft-irtf-cfrg-cpace-21.
/// The desktop is A (initiator), the phone is B (responder). Mirrors app/src/main/companion/cpace.ts.
public enum CPace {
    static let dsi = Data("CPaceRistretto255".utf8)
    static let dsiISK = Data("CPaceRistretto255_ISK".utf8)
    static let sha512Block = 128

    /// LEB128 length (the length half of the draft's prepend_len).
    static func lengthPrefix(_ count: Int) -> Data {
        var len = Data(), n = count
        repeat { len.append(UInt8(n & 0x7f) | (n >= 0x80 ? 0x80 : 0)); n >>= 7 } while n > 0
        return len
    }

    static func prependLen(_ data: Data) -> Data { lengthPrefix(data.count) + data }

    public static func lvCat(_ parts: Data...) -> Data { parts.reduce(Data()) { $0 + prependLen($1) } }

    /// lv_cat streamed into a hash, so a secret part is read where it lives.
    static func feedLV(_ feed: Feed, _ parts: [any Bytes]) {
        for p in parts { feed(lengthPrefix(p.count)); feed(p) }
    }

    public static func generatorString(prs: String, ci: Data, sid: Data) -> Data {
        let p = Data(prs.utf8)
        // pads DSI and PRS out to a whole hash block, so hashing time doesn't depend on the code
        let zpad = max(0, sha512Block - prependLen(p).count - prependLen(dsi).count - 1)
        return lvCat(dsi, p, Data(count: zpad), ci, sid)
    }

    /// The encoded generator g. It's a function of the code, so it's kept in owned storage too.
    static func generatorStorage(prs: String, ci: Data, sid: Data) throws -> SecureBytes {
        var gs = generatorString(prs: prs, ci: ci, sid: sid)
        defer { wipe(&gs) } // made here and never shared, so this zeroes the original
        let hash = Sodium.sha512 { $0(gs) }
        let g = SecureBytes(count: 32)
        guard crypto_core_ristretto255_from_hash(g.ptr, hash.ptr) == 0 else { throw CryptoError.badPoint }
        return g
    }

    public static func generator(prs: String, ci: Data, sid: Data) throws -> Data {
        try generatorStorage(prs: prs, ci: ci, sid: sid).data
    }

    /// 32 random bytes with the bits above 252 cleared (the draft's recommended sampling).
    static func sampleScalar() -> SecureBytes {
        let y = SecureBytes.random(32)
        y[31] &= 0x0f
        return y
    }

    /// scalar_mult_vfy: throws on an invalid encoding or the identity, which means abort.
    static func scalarMultVfy(_ y: some Bytes, _ x: some Bytes) throws -> SecureBytes {
        guard x.count == 32, y.count == 32 else { throw CryptoError.badPoint }
        return try Sodium.out32(y, x, error: .badPoint, crypto_scalarmult_ristretto255)
    }

    /// Wipes K once hashed.
    static func isk(sid: Data, k: SecureBytes, ya: Data, ada: Data, yb: Data, adb: Data) -> Data {
        defer { k.wipe() }
        return Sodium.sha512 { feedLV($0, [dsiISK, sid, k, ya, ada, yb, adb]) }.data
    }

    /// Initiator, step 1: send `ya` (the public share Ya), keep `secret` for `finish`.
    /// Never pass `testScalar` outside test vectors.
    public static func start(prs: String, ci: Data, sid: Data, ada: Data = Data(), testScalar: Data? = nil) throws -> (ya: Data, secret: CPaceSecret) {
        // owned storage: on a throw it's wiped as it goes out of scope
        let scalar = testScalar.map(SecureBytes.init) ?? sampleScalar()
        let ya = try scalarMultVfy(scalar, generatorStorage(prs: prs, ci: ci, sid: sid)).data
        return (ya, CPaceSecret(scalar: scalar, sid: sid, ya: ya, ada: ada))
    }

    /// Initiator, step 2: the 64-byte ISK from the responder's Yb.
    public static func finish(secret: CPaceSecret, yb: Data, adb: Data = Data()) throws -> Data {
        try secret.finish(yb: yb, adb: adb)
    }

    /// Responder: answer the initiator's Ya with Yb and get the same ISK. Never pass `testScalar` outside test vectors.
    public static func respond(prs: String, ci: Data, sid: Data, ya: Data, ada: Data = Data(), adb: Data = Data(), testScalar: Data? = nil) throws -> (yb: Data, isk: Data) {
        let scalar = testScalar.map(SecureBytes.init) ?? sampleScalar()
        defer { scalar.wipe() }
        let yb = try scalarMultVfy(scalar, generatorStorage(prs: prs, ci: ci, sid: sid)).data
        return (yb, isk(sid: sid, k: try scalarMultVfy(scalar, ya), ya: ya, ada: ada, yb: yb, adb: adb))
    }
}
