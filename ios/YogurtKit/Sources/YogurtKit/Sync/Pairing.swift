import Foundation

/// The computer this phone paired with, as its pairConfirm box said.
public struct PairedDesktop: Sendable, Equatable {
    public var id: String
    public var name: String
    public var key: Data
}

/// Why pairing didn't work, in terms the pairing screen can say plainly.
public enum PairingError: Error, Equatable, Sendable {
    /// the code was wrong
    case wrongCode
    /// pairing isn't open on the computer (or the code ran out)
    case expired
    /// too many wrong codes: the computer shows a new one, or says to start again
    case tooMany
    /// the computer couldn't be reached or broke off
    case unreachable
}

private func enc(_ s: String) -> Data { Data(s.utf8) }

private func frame(_ t: Transport, _ o: [String: Any]) async throws {
    try await t.send(JSONSerialization.data(withJSONObject: o))
}

private func message(_ t: Transport, _ type: String) async throws -> [String: Any] {
    guard let v = try JSONSerialization.jsonObject(with: try await t.receive()) as? [String: Any] else { throw PairingError.unreachable }
    if v["type"] as? String == "pairFail" {
        switch v["reason"] as? String {
        case "code": throw PairingError.wrongCode
        case "tooMany": throw PairingError.tooMany
        case "busy": throw SyncError.remote("busy")
        default: throw PairingError.expired
        }
    }
    guard v["type"] as? String == type else { throw PairingError.unreachable }
    return v
}

private func bytes(_ v: Any?, _ n: Int) throws -> Data {
    guard let s = v as? String, let d = Data(base64Encoded: s), d.count == n else { throw PairingError.unreachable }
    return d
}

/// The phone's side of pairing over one fresh connection (app/src/main/companion/pairing.ts); the phone is CPace
/// responder B. The desktop gives each step 3 s and the whole exchange 10 s, so the code is typed before this runs.
/// sid = desktopSession ‖ phoneSession, CI = "yogurt-pair-v1" ‖ desktopSession ‖ phoneSession. Throws
/// `SyncError.remote("busy")` when the desktop asks to try again in a moment.
func pairExchange(_ t: Transport, code: String, phoneName: String, phoneKey: Data, phoneId: String) async throws -> PairedDesktop {
    let phoneSession = Sodium.random(16)
    try await frame(t, ["type": "pairHello", "v": 1, "phoneSession": phoneSession.base64EncodedString(), "phoneName": phoneName])
    let start = try await message(t, "pairStart")
    let desktopSession = try bytes(start["desktopSession"], 16)
    let (yb, iskData) = try CPace.respond(prs: code, ci: enc("yogurt-pair-v1") + desktopSession + phoneSession,
                                          sid: desktopSession + phoneSession, ya: try bytes(start["ya"], 32))
    var isk = iskData
    let keys = PairKeys(isk: isk)
    wipe(&isk)
    try await frame(t, ["type": "pairReply", "yb": yb.base64EncodedString()])
    let confirm = try await message(t, "pairConfirm")
    // a box that doesn't open means the code was wrong; pairDone still goes, so the desktop counts it and says so
    let desktop: PairedDesktop? = (confirm["box"] as? String).flatMap { Data(base64Encoded: $0) }
        .flatMap { try? Box.open(key: keys.toPhone, box: $0, ad: enc("pairConfirm")) }
        .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        .flatMap { v in
            guard let key = try? bytes(v["key"], 32), let id = v["id"] as? String else { return nil }
            return PairedDesktop(id: id, name: (v["name"] as? String) ?? "Computer", key: key)
        }
    let mine = try JSONSerialization.data(withJSONObject: ["key": phoneKey.base64EncodedString(), "name": phoneName, "id": phoneId])
    try await frame(t, ["type": "pairDone", "box": try Box.seal(key: keys.toDesktop, plaintext: mine, ad: enc("pairDone")).base64EncodedString()])
    _ = try await message(t, "pairOk")
    guard let desktop else { throw PairingError.wrongCode }
    return desktop
}
