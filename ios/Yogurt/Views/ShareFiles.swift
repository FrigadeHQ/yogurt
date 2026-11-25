import AVFoundation
import UIKit
import YogurtKit

/// The files Share hands to the share sheet: written to the caches folder with complete protection (unreadable while
/// the phone is locked), each in a folder of its own so the file keeps its plain name. Cleared out ten minutes later
/// (the share sheet may still be reading a recent one), when Yogurt goes to the background, and at launch.
enum ShareFiles {
    static var root: URL { URL.cachesDirectory.appending(path: "Exports", directoryHint: .isDirectory) }

    static let keepFor: TimeInterval = 600

    static func write(_ text: String, name: String) throws -> URL {
        let url = try freshFolder().appending(path: name)
        try Data(text.utf8).write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    /// Removes the exports older than `keepFor`; at launch all of them, since no share sheet is open any more.
    static func clearOld(all: Bool = false) {
        PrivateFolder.prune(root, unusedFor: all ? -1 : keepFor)
    }

    /// One recording as it is; a call's two sides (theirs and the mic) mixed into one m4a, as the player plays them.
    static func audio(_ files: [URL], name: String) async throws -> URL {
        guard let first = files.first else { throw CocoaError(.fileNoSuchFile) }
        let folder = try freshFolder()
        if files.count == 1 {
            let url = folder.appending(path: "\(name).\(first.pathExtension.isEmpty ? "m4a" : first.pathExtension)")
            try FileManager.default.copyItem(at: first, to: url)
            // a copy keeps the recording's own protection; an export gets complete
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            return url
        }
        let mix = AVMutableComposition()
        for f in files {
            let a = AVURLAsset(url: f)
            guard let src = try await a.loadTracks(withMediaType: .audio).first,
                  let track = mix.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
            try track.insertTimeRange(CMTimeRange(start: .zero, duration: try await a.load(.duration)), of: src, at: .zero)
        }
        guard let export = AVAssetExportSession(asset: mix, presetName: AVAssetExportPresetAppleM4A) else { throw CocoaError(.fileWriteUnknown) }
        let url = folder.appending(path: "\(name).m4a")
        try await export.export(to: url, as: .m4a)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        return url
    }

    /// A new folder for one share, after clearing out the old ones.
    private static func freshFolder() throws -> URL {
        clearOld()
        let folder = root.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        // what's written inside takes the folder's protection
        try PrivateFolder.make(folder, protection: .complete)
        return folder
    }

    /// The iOS share sheet for these files, over whatever is showing: AirDrop, Files, Messages, Mail…
    @MainActor static func present(_ urls: [URL]) {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
        guard var top = scene?.keyWindow?.rootViewController else { return }
        while let next = top.presentedViewController { top = next }
        let sheet = UIActivityViewController(activityItems: urls, applicationActivities: nil)
        // where an iPad (or a Mac running the app) anchors the popover; an iPhone shows a sheet
        sheet.popoverPresentationController?.sourceView = top.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.maxX - 40, y: 40, width: 1, height: 1)
        top.present(sheet, animated: true)
    }

    /// The words the files are written in, in the app's language.
    static var labels: ShareExport.Labels {
        ShareExport.Labels(myNotes: S.myNotes, transcript: S.transcript, you: S.you, them: S.them, meeting: S.meeting,
                           with: { S.with($0) }, recordedWith: { S.recordedWith($0) })
    }
}
