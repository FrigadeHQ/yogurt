import Foundation

// The microphone meter, the same as desktop's (app/src/shared/wave.ts), so a voice moves the bars the same way.

private let meterGain = 10.0

/// 0…1 for the meter from a level in dBFS: −51 dBFS and below is still, −12 and above is full, and quiet speech
/// gets more travel while loud speech keeps headroom.
public func micLevel(dbfs: Double) -> Double {
    guard dbfs.isFinite else { return 0 }
    // desktop's capture level is 1 + dBFS / 60
    let me = 1 + dbfs / 60
    let level = max(0, min(1, (me - 0.15) / 0.65))
    return meterGain * level / (1 + (meterGain - 1) * level)
}

/// dBFS of a buffer's samples, by RMS; silence is −∞.
public func dbfs(rms samples: UnsafeBufferPointer<Float>) -> Double {
    guard !samples.isEmpty else { return -.infinity }
    var sum: Double = 0
    for s in samples { sum += Double(s) * Double(s) }
    let rms = (sum / Double(samples.count)).squareRoot()
    return rms > 0 ? 20 * log10(rms) : -.infinity
}

public func dbfs(rms samples: [Float]) -> Double { samples.withUnsafeBufferPointer { dbfs(rms: $0) } }

/// Smooths the meter's ~10 Hz feed: quick to rise, gentle to fall.
public struct Wave: Sendable {
    public var target: Double = 0
    public private(set) var level: Double = 0

    public init() {}

    public mutating func step(_ dtMs: Double) {
        let tau = target > level ? 60.0 : 220.0
        level += (target - level) * (1 - exp(-dtMs / tau))
        if target == 0 && level < 0.002 { level = 0 }
    }
}
