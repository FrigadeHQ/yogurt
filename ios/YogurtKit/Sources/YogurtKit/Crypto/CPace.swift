import Clibsodium
import Foundation

/// The initiator's state between `start` and `finish`. Single use: `finish` wipes the scalar.
public final class CPaceSecret {
    private(set) var scalar: Data
    let sid: Data, ya: Data, ada: Data
    private var used = false

    init(scalar: Data, sid: Data, ya: Data, ada: Data) {
        self.scalar = scalar; self.sid = sid; self.ya = ya; self.ada = ada
    }

    func take() throws -> Data {
        guard !used else { throw CryptoError.secretUsed }
        used = true
        return scalar
    }

    func wipeScalar() { wipe(&scalar) }
}

/// CPace on ristretto255 + SHA-512, initiator/responder setting, exactly as draft-irtf-cfrg-cpace-21.
/// The desktop is A (initiator), the phone is B (responder). Mirrors app/src/main/companion/cpace.ts.
public enum CPace {
    static let dsi = Data("CPaceRistretto255".utf8)
    static let dsiISK = Data("CPaceRistretto255_ISK".utf8)
    static let sha512Block = 128

    /// LEB128 length, then the bytes (the draft's prepend_len).
    static func prependLen(_ data: Data) -> Data {
        var len = Data(), n = data.count
        repeat { len.append(UInt8(n & 0x7f) | (n >= 0x80 ? 0x80 : 0)); n >>= 7 } while n > 0
        return len + data
    }

    public static func lvCat(_ parts: Data...) -> Data { lvCat(parts) }
    static func lvCat(_ parts: [Data]) -> Data { parts.reduce(Data()) { $0 + prependLen($1) } }

    public static func generatorString(prs: String, ci: Data, sid: Data) -> Data {
        let p = Data(prs.utf8)
        // pads DSI and PRS out to a whole hash block, so hashing time doesn't depend on the code
        let zpad = max(0, sha512Block - prependLen(p).count - prependLen(dsi).count - 1)
        return lvCat(dsi, p, Data(count: zpad), ci, sid)
    }

    /// The encoded generator g.
    public static func generator(prs: String, ci: Data, sid: Data) throws -> Data {
        _ = Sodium.ready
        var g = [UInt8](repeating: 0, count: 32)
        guard crypto_core_ristretto255_from_hash(&g, [UInt8](Sodium.sha512(generatorString(prs: prs, ci: ci, sid: sid)))) == 0 else { throw CryptoError.badPoint }
        return Data(g)
    }

    /// 32 random bytes with the bits above 252 cleared (the draft's recommended sampling).
    static func sampleScalar() -> Data {
        var y = Sodium.random(32)
        y[31] &= 0x0f
        return y
    }

    /// scalar_mult_vfy: throws on an invalid encoding or the identity, which means abort.
    static func scalarMultVfy(_ y: Data, _ x: Data) throws -> Data {
        guard x.count == 32, y.count == 32 else { throw CryptoError.badPoint }
        return try Sodium.out32(y, x, error: .badPoint, crypto_scalarmult_ristretto255)
    }

    static func isk(sid: Data, k: Data, ya: Data, ada: Data, yb: Data, adb: Data) -> Data {
        Sodium.sha512(lvCat(dsiISK, sid, k) + lvCat(ya, ada) + lvCat(yb, adb))
    }

    /// Initiator, step 1: send `ya` (the public share Ya), keep `secret` for `finish`. `testScalar` is for test vectors only.
    public static func start(prs: String, ci: Data, sid: Data, ada: Data = Data(), testScalar: Data? = nil) throws -> (ya: Data, secret: CPaceSecret) {
        let scalar = testScalar ?? sampleScalar()
        let ya = try scalarMultVfy(scalar, generator(prs: prs, ci: ci, sid: sid))
        return (ya, CPaceSecret(scalar: scalar, sid: sid, ya: ya, ada: ada))
    }

    /// Initiator, step 2: the 64-byte ISK from the responder's Yb.
    public static func finish(secret: CPaceSecret, yb: Data, adb: Data = Data()) throws -> Data {
        let scalar = try secret.take()
        defer { secret.wipeScalar() }
        return isk(sid: secret.sid, k: try scalarMultVfy(scalar, yb), ya: secret.ya, ada: secret.ada, yb: yb, adb: adb)
    }

    /// Responder: answer the initiator's Ya with Yb and get the same ISK. `testScalar` is for test vectors only.
    public static func respond(prs: String, ci: Data, sid: Data, ya: Data, ada: Data = Data(), adb: Data = Data(), testScalar: Data? = nil) throws -> (yb: Data, isk: Data) {
        var scalar = testScalar ?? sampleScalar()
        defer { wipe(&scalar) }
        let yb = try scalarMultVfy(scalar, generator(prs: prs, ci: ci, sid: sid))
        return (yb, isk(sid: sid, k: try scalarMultVfy(scalar, ya), ya: ya, ada: ada, yb: yb, adb: adb))
    }
}
