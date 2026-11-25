import Foundation
import Testing
@testable import YogurtKit

@Suite struct CalmStatusTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    let synced = ConnectionStatus.connected("MacBook", syncing: nil)
    let syncing = ConnectionStatus.connected("MacBook", syncing: 0)
    let offline = ConnectionStatus.offline("MacBook", lastSync: nil)

    func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    /// runs the pill's clock: settles at each check it asks for, up to `until`
    func run(_ calm: inout CalmStatus, until end: TimeInterval) {
        while let next = calm.nextCheck, next <= at(end) { calm.settle(at: next) }
    }

    @Test func theFirstStatusShowsAtOnce() {
        let calm = CalmStatus(.searching, at: t0)
        #expect(calm.shown == .searching)
        #expect(calm.nextCheck == nil)
    }

    @Test func aQuickSyncNeverShows() {
        var calm = CalmStatus(synced, at: t0)
        calm.update(.connecting("MacBook"), at: at(5))
        #expect(calm.shown == synced)
        calm.update(syncing, at: at(5.2))
        calm.update(synced, at: at(5.5))
        run(&calm, until: 10)
        #expect(calm.shown == synced)
        #expect(calm.nextCheck == nil)
    }

    @Test func aLongSyncShows() {
        var calm = CalmStatus(synced, at: t0)
        calm.update(syncing, at: at(5))
        calm.settle(at: at(5.5))
        #expect(calm.shown == synced)
        #expect(calm.nextCheck == at(5.6))
        calm.settle(at: at(5.6))
        #expect(calm.shown == syncing)
    }

    @Test func busyStatesInARowCountFromTheFirst() {
        var calm = CalmStatus(offline, at: t0)
        calm.update(.connecting("MacBook"), at: at(5))
        calm.update(syncing, at: at(5.4))
        calm.settle(at: at(5.6))
        #expect(calm.shown == syncing)
    }

    @Test func aShownStatusStaysAtLeastASecond() {
        var calm = CalmStatus(synced, at: t0)
        calm.update(syncing, at: at(5))
        calm.settle(at: at(5.6))
        #expect(calm.shown == syncing)
        calm.update(synced, at: at(5.8))
        calm.settle(at: at(6.2))
        #expect(calm.shown == syncing)
        #expect(calm.nextCheck == at(6.6))
        calm.settle(at: at(6.6))
        #expect(calm.shown == synced)
    }

    @Test func neverFlashesBetweenTwoLabels() {
        var calm = CalmStatus(synced, at: t0)
        var seen: [(ConnectionStatus, Date)] = [(calm.shown, t0)]
        // the computer drops in and out quickly for a few seconds
        var t: TimeInterval = 5
        for s in [offline, .connecting("MacBook"), synced, offline, .connecting("MacBook"), syncing, synced, offline, synced] {
            calm.update(s, at: at(t))
            t += 0.3
            while let next = calm.nextCheck, next <= at(t) {
                calm.settle(at: next)
                if calm.shown != seen.last!.0 { seen.append((calm.shown, next)) }
            }
        }
        run(&calm, until: 30)
        if calm.shown != seen.last!.0 { seen.append((calm.shown, calm.nextCheck ?? at(30))) }
        for (a, b) in zip(seen, seen.dropFirst()) { #expect(b.1.timeIntervalSince(a.1) >= 1) }
    }

    @Test func theLatestStatusIsAlwaysShownInTheEnd() {
        var calm = CalmStatus(synced, at: t0)
        calm.update(offline, at: at(5))
        calm.update(.connecting("MacBook"), at: at(5.1))
        calm.update(syncing, at: at(5.2))
        calm.update(.offline("MacBook", lastSync: at(5.2)), at: at(5.3))
        run(&calm, until: 20)
        #expect(calm.shown == .offline("MacBook", lastSync: at(5.2)))
        #expect(calm.nextCheck == nil)
    }

    @Test func aSettledChangeShowsWithoutTheBusyWait() {
        var calm = CalmStatus(synced, at: t0)
        calm.update(offline, at: at(5))
        #expect(calm.shown == offline)
    }

    @Test func errorsShowAtOnce() {
        var calm = CalmStatus(synced, at: t0)
        calm.update(syncing, at: at(5))
        calm.settle(at: at(5.6))
        #expect(calm.shown == syncing)
        // even while the last one is still in its second
        calm.update(.error("Pair again."), at: at(5.7))
        #expect(calm.shown == .error("Pair again."))
    }
}
