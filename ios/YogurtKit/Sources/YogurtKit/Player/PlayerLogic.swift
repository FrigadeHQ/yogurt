import Foundation

/// Where a note's audio comes from.
public enum AudioSource: Equatable, Sendable {
    /// recorded on this iPhone and not yet taken by the computer
    case phone
    /// fetched from the computer before and kept in the caches folder
    case cached
    /// not here yet, but the computer is
    case computer
    case none
}

/// What the Note screen's player decides, apart from AVFoundation: source, time, scrubber, speed.
public enum PlayerLogic {
    public static func source(phoneFile: Bool, cached: Bool, connected: Bool) -> AudioSource {
        if phoneFile { return .phone }
        if cached { return .cached }
        return connected ? .computer : .none
    }

    /// "3:05", or "1:02:03" from an hour.
    public static func clock(ms: Int) -> String {
        let s = max(0, ms) / 1000
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    /// Desktop starts a second early, so the first word isn't clipped.
    public static func seekMs(forLineAt ms: Int) -> Int { max(0, ms - 1000) }

    public static func fraction(ms: Int, duration: Int) -> Double {
        guard duration > 0 else { return 0 }
        return min(1, max(0, Double(ms) / Double(duration)))
    }

    public static func ms(atFraction f: Double, duration: Int) -> Int {
        Int((min(1, max(0, f)) * Double(max(0, duration))).rounded())
    }

    public static let rates: [Double] = [1, 1.5, 2]

    public static func nextRate(_ rate: Double) -> Double {
        guard let i = rates.firstIndex(of: rate) else { return 1 }
        return rates[(i + 1) % rates.count]
    }

    public static func rateLabel(_ rate: Double) -> String {
        (rate == rate.rounded() ? String(Int(rate)) : String(rate)) + "×"
    }

    /// The line playing at this moment: the last one that has started, else the first.
    public static func line(at ms: Int, starts: [Int]) -> Int? {
        guard !starts.isEmpty else { return nil }
        return starts.lastIndex { $0 <= ms } ?? 0
    }

    /// AVPlayer reads these; the desktop may serve ogg (Windows and Linux), which it can't.
    public static func canPlay(ext: String) -> Bool {
        ["m4a", "mp4", "aac", "mp3", "wav", "caf"].contains(ext.lowercased())
    }
}
