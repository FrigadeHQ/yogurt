@preconcurrency import AVFoundation
import Foundation

/// The phone records crash-safe AAC m4a, but only a Mac's helper decodes m4a. What goes to the computer is 16 kHz mono
/// 16-bit WAV, the audio desktop turns every uploaded file into, so Windows and Linux transcribe it too.
public enum PhoneAudio {
    public enum ExportError: Error { case noAudio, convert }

    /// Streams the recording through a converter in pieces, so hours of audio never sit in memory.
    public static func wav(from source: URL, to target: URL) throws {
        let input = try AVAudioFile(forReading: source)
        guard input.length > 0 else { throw ExportError.noAudio }
        let from = input.processingFormat
        guard let to = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: from, to: to) else { throw ExportError.convert }

        // a meeting's audio: readable while locked only once opened, like the recordings it's made from
        #if os(iOS)
        FileManager.default.createFile(atPath: target.path, contents: header(dataBytes: 0),
                                       attributes: [.protectionKey: FileProtectionType.completeUnlessOpen])
        #else
        FileManager.default.createFile(atPath: target.path, contents: header(dataBytes: 0))
        #endif
        let out = try FileHandle(forWritingTo: target)
        defer { try? out.close() }
        try out.seekToEnd()

        let readFrames: AVAudioFrameCount = 32768
        guard let readBuf = AVAudioPCMBuffer(pcmFormat: from, frameCapacity: readFrames),
              let outBuf = AVAudioPCMBuffer(pcmFormat: to, frameCapacity: AVAudioFrameCount(Double(readFrames) * 16000 / from.sampleRate) + 1024)
        else { throw ExportError.convert }
        var written = 0
        let reading = Reading()
        while true {
            outBuf.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: outBuf, error: &error) { _, inputStatus in
                if reading.ended { inputStatus.pointee = .endOfStream; return nil }
                do {
                    try input.read(into: readBuf, frameCount: readFrames)
                } catch {
                    // a file cut short by a crash ends where its last whole piece does
                    reading.error = error
                    readBuf.frameLength = 0
                }
                if readBuf.frameLength == 0 { reading.ended = true; inputStatus.pointee = .endOfStream; return nil }
                inputStatus.pointee = .haveData
                return readBuf
            }
            if status == .error { throw error ?? ExportError.convert }
            if outBuf.frameLength > 0, let p = outBuf.int16ChannelData {
                let bytes = Int(outBuf.frameLength) * 2
                try out.write(contentsOf: Data(bytes: p[0], count: bytes))
                written += bytes
            }
            if status == .endOfStream || (reading.ended && outBuf.frameLength == 0) { break }
        }
        guard written > 0 else { throw reading.error ?? ExportError.noAudio }
        try out.seek(toOffset: 0)
        try out.write(contentsOf: header(dataBytes: written))
    }

    /// the converter's input block runs on this thread; a box keeps the compiler content
    private final class Reading: @unchecked Sendable { var ended = false; var error: Error? }

    /// The canonical 44-byte header: PCM, mono, 16 kHz, 16-bit.
    static func header(dataBytes: Int) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + dataBytes))
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(dataBytes))
        return d
    }
}
