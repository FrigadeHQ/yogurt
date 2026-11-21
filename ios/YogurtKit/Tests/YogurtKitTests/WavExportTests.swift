import AVFoundation
import Foundation
import Testing
@testable import YogurtKit

/// Made-up audio: a second and a half of a quiet tone, written as AAC m4a like the phone records.
private func toneM4A(seconds: Double = 1.5, rate: Double = 48000) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("tone-\(UUID().uuidString).m4a")
    let file = try AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate,
                                                           AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000])
    let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
    let n = AVAudioFrameCount(seconds * rate)
    let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n)!
    buf.frameLength = n
    for i in 0..<Int(n) { buf.floatChannelData![0][i] = Float(sin(Double(i) * 2 * .pi * 440 / rate)) * 0.3 }
    try file.write(from: buf)
    return url
}

/// Made-up audio written the way the phone's Recorder writes it, AAC through AVAssetWriter in fragments, and left
/// unfinished as a killed app leaves it.
private func fragmentedM4A(seconds: Double, rate: Double = 48000) async throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("frag-\(UUID().uuidString).m4a")
    let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
    writer.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate,
                                                                       AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000])
    writer.add(input)
    #expect(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
    var desc: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: nil, asbd: format.streamDescription, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                   magicCookie: nil, extensions: nil, formatDescriptionOut: &desc)
    let piece = AVAudioFrameCount(rate / 10)
    var frames: Int64 = 0
    while Double(frames) < seconds * rate {
        let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: piece)!
        buf.frameLength = piece
        for i in 0..<Int(piece) { buf.floatChannelData![0][i] = Float(sin(Double(frames + Int64(i)) * 2 * .pi * 440 / rate)) * 0.3 }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(rate)),
                                        presentationTimeStamp: CMTime(value: frames, timescale: CMTimeScale(rate)), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreate(allocator: nil, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil, formatDescription: desc!,
                             sampleCount: CMItemCount(piece), sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0,
                             sampleSizeArray: nil, sampleBufferOut: &sample)
        CMSampleBufferSetDataBufferFromAudioBufferList(sample!, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0,
                                                       bufferList: buf.audioBufferList)
        while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(2)) }
        #expect(input.append(sample!))
        frames += Int64(piece)
    }
    // never finished, as when the app is killed: what's on disk is what the fragments wrote so far
    try await Task.sleep(for: .seconds(1.5))
    let copy = url.deletingPathExtension().appendingPathExtension("killed.m4a")
    try FileManager.default.copyItem(at: url, to: copy)
    writer.cancelWriting()
    try? FileManager.default.removeItem(at: url)
    return copy
}

@Suite struct WavExportTests {
    @Test func aRecordingCutShortByACrashStillConvertsUpToWhereItEnds() async throws {
        let m4a = try await fragmentedM4A(seconds: 6)
        let wav = FileManager.default.temporaryDirectory.appendingPathComponent("cut-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: m4a); try? FileManager.default.removeItem(at: wav) }
        // cut in the middle of a fragment written before the app was killed
        let killed = try Data(contentsOf: m4a)
        try killed.prefix(killed.count / 2).write(to: m4a)
        try PhoneAudio.wav(from: m4a, to: wav)
        let d = try Data(contentsOf: wav)
        let seconds = Double(d.count - 44) / 32000
        // the fragments before the cut, and nothing made up after it
        #expect(seconds > 2 && seconds < 5.5)
    }

    @Test func anM4AFromThePhoneBecomes16kMono16BitWav() throws {
        let m4a = try toneM4A()
        let wav = FileManager.default.temporaryDirectory.appendingPathComponent("out-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: m4a); try? FileManager.default.removeItem(at: wav) }
        try PhoneAudio.wav(from: m4a, to: wav)
        let d = try Data(contentsOf: wav)
        let u16 = { (o: Int) in UInt16(d[o]) | UInt16(d[o + 1]) << 8 }
        let u32 = { (o: Int) in UInt32(u16(o)) | UInt32(u16(o + 2)) << 16 }
        #expect(String(decoding: d[0..<4], as: UTF8.self) == "RIFF")
        #expect(String(decoding: d[8..<12], as: UTF8.self) == "WAVE")
        #expect(String(decoding: d[12..<16], as: UTF8.self) == "fmt ")
        #expect(u16(20) == 1 && u16(22) == 1 && u32(24) == 16000 && u16(34) == 16)
        #expect(String(decoding: d[36..<40], as: UTF8.self) == "data")
        #expect(Int(u32(40)) == d.count - 44)
        #expect(Int(u32(4)) == d.count - 8)
        // about 1.5 s of samples, and not silence
        let samples = (d.count - 44) / 2
        #expect(abs(samples - 24000) < 2000)
        let peak = stride(from: 44, to: d.count - 1, by: 2).map { abs(Int(Int16(bitPattern: u16($0)))) }.max() ?? 0
        #expect(peak > 3000)
    }

    @Test func somethingThatIsNotAudioThrows() throws {
        let junk = FileManager.default.temporaryDirectory.appendingPathComponent("junk-\(UUID().uuidString).m4a")
        try Data("made-up, not audio".utf8).write(to: junk)
        defer { try? FileManager.default.removeItem(at: junk) }
        #expect(throws: (any Error).self) { try PhoneAudio.wav(from: junk, to: junk.appendingPathExtension("wav")) }
    }
}

@MainActor @Suite struct WavUploadTests {
    @Test func aRealRecordingGoesToTheComputerAsWavAndTheCopyIsGone() async throws {
        let rig = try Rig()
        let m4a = try toneM4A(seconds: 1)
        defer { try? FileManager.default.removeItem(at: m4a) }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        let rec = LocalRecording(id: "w1", title: "Hallway", startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 11),
                                 attendees: [], audioURL: m4a, myNotes: "", transcript: [], summary: nil)
        try await rig.engine.upload(rec)
        #expect(await eventually { rig.store.localRecordings().first?.uploadedAt != nil })
        let sent = try #require(rig.desktop.importedAudio["w1"])
        #expect(String(decoding: sent.prefix(4), as: UTF8.self) == "RIFF")
        #expect(rig.desktop.requests("uploadAudio").allSatisfy { $0["mime"] as? String == "audio/wav" })
        // the WAV is made for the upload and thrown away after it; the phone's m4a stays until it lets it go
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: testConfigUploads(rig).path)) ?? []
        #expect(!leftovers.contains { $0.hasPrefix("w1") })
        #expect(FileManager.default.fileExists(atPath: m4a.path))
    }

    @Test func audioThatDoesNotDecodeIsSentAsItIs() async throws {
        let rig = try Rig()
        let junk = FileManager.default.temporaryDirectory.appendingPathComponent("j1-\(UUID().uuidString).m4a")
        try Data("made-up bytes".utf8).write(to: junk)
        defer { try? FileManager.default.removeItem(at: junk) }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        try await rig.engine.upload(LocalRecording(id: "j1", title: "x", startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 11),
                                                   attendees: [], audioURL: junk, myNotes: "", transcript: [], summary: nil))
        #expect(await eventually { rig.store.localRecordings().first?.uploadedAt != nil })
        #expect(rig.desktop.requests("uploadAudio").allSatisfy { $0["mime"] as? String == "audio/mp4" })
    }

    @Test func aFailedUploadKeepsItsWavForTheNextTryAndWaitsBeforeIt() async throws {
        let rig = try Rig()
        let m4a = try toneM4A(seconds: 1)
        defer { try? FileManager.default.removeItem(at: m4a) }
        rig.desktop.uploadAudioReply = { body in ["received": body["index"] as? Int ?? 0, "done": true] }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        try await rig.engine.upload(LocalRecording(id: "w2", title: "Hallway", startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 11),
                                                   attendees: [], audioURL: m4a, myNotes: "", transcript: [], summary: nil))
        // it says so, and doesn't send it again at once
        #expect(rig.engine.status == .error(SyncEngine.uploadFailed("Test Mac")))
        let cached = testConfigUploads(rig).appendingPathComponent("w2.wav")
        #expect(FileManager.default.fileExists(atPath: cached.path))
        await rig.engine.syncNow()
        #expect(rig.desktop.requests("uploadMeeting").count == 1)
        // the next try sends the WAV made for the first one
        let marker = PhoneAudio.header(dataBytes: 4) + Data([1, 2, 3, 4])
        try marker.write(to: cached)
        rig.desktop.uploadAudioReply = nil
        #expect(await eventually { rig.store.localRecordings().first?.uploadedAt != nil })
        #expect(rig.desktop.importedAudio["w2"] == marker)
        #expect(!FileManager.default.fileExists(atPath: cached.path))
        #expect(await eventually { rig.connected })
    }

    @Test func withoutRoomForTheWavTheRecordingGoesAsItIs() async throws {
        var config = testConfig()
        config.freeSpace = { 1000 }
        let rig = try Rig(config: config)
        let m4a = try toneM4A(seconds: 1)
        defer { try? FileManager.default.removeItem(at: m4a) }
        rig.engine.setForeground(true)
        #expect(await eventually { rig.connected })
        try await rig.engine.upload(LocalRecording(id: "w3", title: "Hallway", startedAt: Date(timeIntervalSince1970: 10), endedAt: Date(timeIntervalSince1970: 11),
                                                   attendees: [], audioURL: m4a, myNotes: "", transcript: [], summary: nil))
        #expect(await eventually { rig.store.localRecordings().first?.uploadedAt != nil })
        #expect(rig.desktop.requests("uploadAudio").allSatisfy { $0["mime"] as? String == "audio/mp4" })
    }

    @Test func uploadFilesLeftByAnEarlierRunAreSweptAtLaunch() throws {
        let config = testConfig()
        try FileManager.default.createDirectory(at: config.uploadFolder, withIntermediateDirectories: true)
        let left = config.uploadFolder.appendingPathComponent("old-1234.wav")
        try Data([1, 2, 3]).write(to: left)
        _ = try Rig(config: config)
        #expect(!FileManager.default.fileExists(atPath: left.path))
    }
}

@MainActor private func testConfigUploads(_ rig: Rig) -> URL { rig.engine.uploadFolder }
