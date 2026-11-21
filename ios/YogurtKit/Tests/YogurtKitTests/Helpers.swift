import Foundation

extension Data {
    init(hex: String) {
        var out = Data(capacity: hex.count / 2)
        var it = hex.makeIterator()
        while let a = it.next(), let b = it.next() { out.append(UInt8(String([a, b]), radix: 16)!) }
        self = out
    }
    var hex: String { map { String(format: "%02x", $0) }.joined() }
    static func random(_ n: Int) -> Data { Data((0..<n).map { _ in UInt8.random(in: 0...255) }) }
}

func utf8(_ s: String) -> Data { Data(s.utf8) }

/// ios/Fixtures, found from this file so tests work from any working directory.
func fixture<T: Decodable>(_ name: String, as: T.Type = T.self) throws -> T {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/\(name)")
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
}
