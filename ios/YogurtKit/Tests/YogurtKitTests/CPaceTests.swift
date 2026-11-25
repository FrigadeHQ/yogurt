import Foundation
import Testing
@testable import YogurtKit

private struct Fixtures: Decodable { let vectors: [[String: String]]; let scalarMult: [String: String]; let invalidPoints: [String] }
private let fixtures = try! fixture("cpace-ristretto255-vectors.json", as: Fixtures.self)
private let vectors = fixtures.vectors

@Suite struct CPaceTests {
    @Test func lvCatMatchesTheDraft() {
        #expect(CPace.lvCat(utf8("1234"), utf8("5"), Data(), utf8("678")).hex == "043132333401350003363738")
        #expect(CPace.lvCat(Data(count: 128)).hex.prefix(4) == "8001")
    }

    @Test(arguments: vectors) func generator(_ v: [String: String]) throws {
        let prs = String(decoding: Data(hex: v["PRS"]!), as: UTF8.self)
        #expect(CPace.generatorString(prs: prs, ci: Data(hex: v["CI"]!), sid: Data(hex: v["sid"]!)).hex == v["generatorString"])
        #expect(try CPace.generator(prs: prs, ci: Data(hex: v["CI"]!), sid: Data(hex: v["sid"]!)).hex == v["g"])
    }

    @Test(arguments: vectors) func sharesAndInitiatorResponderISK(_ v: [String: String]) throws {
        let prs = String(decoding: Data(hex: v["PRS"]!), as: UTF8.self)
        let ci = Data(hex: v["CI"]!), sid = Data(hex: v["sid"]!)
        let a = try CPace.start(prs: prs, ci: ci, sid: sid, ada: Data(hex: v["ADa"]!), testScalar: Data(hex: v["ya"]!))
        #expect(a.ya.hex == v["Ya"])
        let b = try CPace.respond(prs: prs, ci: ci, sid: sid, ya: a.ya, ada: Data(hex: v["ADa"]!), adb: Data(hex: v["ADb"]!), testScalar: Data(hex: v["yb"]!))
        #expect(b.yb.hex == v["Yb"])
        #expect(b.isk.hex == v["ISK_IR"])
        #expect(try CPace.finish(secret: a.secret, yb: b.yb, adb: Data(hex: v["ADb"]!)).hex == v["ISK_IR"])
    }

    @Test func scalarMultMatchesTheDraft() throws {
        let s = fixtures.scalarMult
        #expect(try CPace.scalarMultVfy(Data(hex: s["s"]!), Data(hex: s["X"]!)).data.hex == s["result"])
    }

    @Test func randomRunsAgreeAndAWrongCodeDoesNot() throws {
        let ci = utf8("yogurt-pair-v1"), sid = Data.random(32)
        let a = try CPace.start(prs: "123456", ci: ci, sid: sid)
        let b = try CPace.respond(prs: "123456", ci: ci, sid: sid, ya: a.ya)
        let isk = try CPace.finish(secret: a.secret, yb: b.yb)
        #expect(isk.count == 64)
        #expect(isk == b.isk)

        let a2 = try CPace.start(prs: "123456", ci: ci, sid: sid)
        let wrong = try CPace.respond(prs: "123457", ci: ci, sid: sid, ya: a2.ya)
        #expect(try CPace.finish(secret: a2.secret, yb: wrong.yb) != wrong.isk)
    }

    @Test func aDifferentChannelOrSessionIdGivesADifferentKey() throws {
        let sid = Data.random(16)
        let a = try CPace.start(prs: "123456", ci: utf8("yogurt-pair-v1A"), sid: sid)
        let b = try CPace.respond(prs: "123456", ci: utf8("yogurt-pair-v1B"), sid: sid, ya: a.ya)
        #expect(try CPace.finish(secret: a.secret, yb: b.yb) != b.isk)
        let c = try CPace.start(prs: "123456", ci: utf8("ci"), sid: sid)
        let d = try CPace.respond(prs: "123456", ci: utf8("ci"), sid: .random(16), ya: c.ya)
        #expect(try CPace.finish(secret: c.secret, yb: d.yb) != d.isk)
    }

    @Test func rejectsTheIdentityAndInvalidEncodingsFromEitherSide() throws {
        let ci = utf8("ci"), sid = Data.random(16)
        for bad in fixtures.invalidPoints {
            #expect(throws: CryptoError.self) { try CPace.respond(prs: "123456", ci: ci, sid: sid, ya: Data(hex: bad)) }
            let a = try CPace.start(prs: "123456", ci: ci, sid: sid)
            #expect(throws: CryptoError.self) { try CPace.finish(secret: a.secret, yb: Data(hex: bad)) }
        }
        let a = try CPace.start(prs: "1", ci: ci, sid: sid)
        #expect(throws: CryptoError.self) { try CPace.finish(secret: a.secret, yb: Data(count: 31)) }
    }

    @Test func theSecretIsSingleUse() throws {
        let ci = utf8("ci"), sid = Data.random(16)
        let a = try CPace.start(prs: "1", ci: ci, sid: sid)
        let b = try CPace.respond(prs: "1", ci: ci, sid: sid, ya: a.ya)
        _ = try CPace.finish(secret: a.secret, yb: b.yb)
        #expect(throws: CryptoError.self) { try CPace.finish(secret: a.secret, yb: b.yb) }
    }

    @Test func samplesScalarsBelow2To252() throws {
        for _ in 0..<20 { #expect(try CPace.start(prs: "1", ci: utf8("ci"), sid: .random(16)).secret.scalarStorage[31] < 0x10) }
    }
}

@Suite struct PairingKeyTests {
    @Test func threeDifferent32ByteKeysTheSameOnBothSides() {
        let isk = Data.random(64)
        let k = PairKeys(isk: isk)
        for key in [k.toPhone, k.toDesktop, k.confirm] { #expect(key.count == 32) }
        #expect(Set([k.toPhone, k.toDesktop, k.confirm]).count == 3)
        #expect(PairKeys(isk: isk).toPhone == k.toPhone)
        #expect(PairKeys(isk: .random(64)).toPhone != k.toPhone)
    }

    // Computed with node:crypto hkdfSync('sha512', isk, empty salt, label, 32), what the desktop runs
    @Test func matchesTheDesktopHKDF() {
        let k = PairKeys(isk: Data((0..<64).map { UInt8($0) }))
        #expect(k.toPhone.hex == HKDFVector.toPhone)
        #expect(k.toDesktop.hex == HKDFVector.toDesktop)
        #expect(k.confirm.hex == HKDFVector.confirm)
    }

    @Test func sealsAndOpensAndAnyChangeFails() throws {
        let key = Data.random(32), ad = utf8("pairConfirm")
        let box = try Box.seal(key: key, plaintext: utf8("hello"), ad: ad)
        #expect(box.count == 24 + 5 + 16)
        #expect(try Box.open(key: key, box: box, ad: ad) == utf8("hello"))
        var tampered = box; tampered[30] ^= 1
        #expect(throws: CryptoError.self) { try Box.open(key: key, box: tampered, ad: ad) }
        #expect(throws: CryptoError.self) { try Box.open(key: .random(32), box: box, ad: ad) }
        #expect(throws: CryptoError.self) { try Box.open(key: key, box: box, ad: utf8("pairDone")) }
        #expect(throws: CryptoError.self) { try Box.open(key: key, box: box.prefix(20), ad: ad) }
        #expect(throws: CryptoError.self) { try Box.seal(key: Data(count: 31), plaintext: Data(), ad: ad) }
        #expect(try Box.seal(key: key, plaintext: utf8("hello"), ad: ad) != box)
    }
}

private enum HKDFVector {
    static let toPhone = "0030e95c71ba34b686d033b50053631010139ff50ca994bec59dc9993d322979"
    static let toDesktop = "b81495d5fc6579f4b598f5d5ca8c0cfb8c7d2c10d1f4431c7da7beb91311ae6e"
    static let confirm = "528a836194fec83107cf9f4daf4484fe43da5b59ee31050254801805163696f8"
}
