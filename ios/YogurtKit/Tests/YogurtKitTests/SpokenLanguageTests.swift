import Foundation
import Testing
@testable import YogurtKit

@Suite struct SpokenLanguageTests {
    let phone = Locale(identifier: "en_US")
    let supported = [Locale(identifier: "de-DE"), Locale(identifier: "en-US"), Locale(identifier: "fr-FR"), Locale(identifier: "en-US")]

    @Test func nothingPickedFollowsTheIPhone() {
        #expect(SpokenLanguage.locale(picked: nil, phone: phone).identifier == "en_US")
        #expect(SpokenLanguage.locale(picked: "", phone: phone).identifier == "en_US")
    }

    @Test func aPickedLanguageIsUsed() {
        #expect(SpokenLanguage.locale(picked: "de-DE", phone: phone).identifier(.bcp47) == "de-DE")
        #expect(SpokenLanguage.locale(picked: "de-DE", phone: phone, supported: supported).identifier(.bcp47) == "de-DE")
    }

    @Test func aPickThisIPhoneNoLongerHasFallsBackToTheIPhonesLanguage() {
        #expect(SpokenLanguage.locale(picked: "pt-BR", phone: phone, supported: supported).identifier == "en_US")
        // an empty list is "not known yet", not "nothing works": the pick stays
        #expect(SpokenLanguage.locale(picked: "pt-BR", phone: phone, supported: []).identifier(.bcp47) == "pt-BR")
    }

    @Test func theListHasEachLanguageOnceSortedByItsNameInTheInterfaceLanguage() {
        let english = SpokenLanguage.options(supported, in: Locale(identifier: "en"))
        #expect(english.map(\.id) == ["en-US", "fr-FR", "de-DE"])
        #expect(english.first?.name == "English (United States)")
        let german = SpokenLanguage.options(supported, in: Locale(identifier: "de"))
        #expect(german.map(\.id) == ["de-DE", "en-US", "fr-FR"])
        #expect(german.first?.name == "Deutsch (Deutschland)")
    }

    @Test func theIPhonesLanguageIsNamedInTheInterfaceLanguage() {
        #expect(SpokenLanguage.name(of: phone, in: Locale(identifier: "en")) == "English")
        #expect(SpokenLanguage.name(of: phone, in: Locale(identifier: "de")) == "Englisch")
        #expect(SpokenLanguage.name(of: Locale(identifier: "ja_JP"), in: Locale(identifier: "ja")) == "日本語")
    }

    @Test func theComputerIsToldTheLanguageCode() {
        #expect(SpokenLanguage.code(Locale(identifier: "de_DE")) == "de")
        #expect(SpokenLanguage.code(Locale(identifier: "zh-Hant-TW")) == "zh")
        #expect(SpokenLanguage.code(Locale(identifier: "en-US")) == "en")
    }

    @Test func notesInALanguageAppleIntelligenceCanNotWriteKeepTheTranscriptAndSaySo() {
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: true, languageSupported: false, paired: false) == .languageNotSupported)
        // the computer writes notes in any language
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: true, languageSupported: false, paired: true) == .computerWillWrite)
        // without the model at all, that's the plainer thing to say
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: false, languageSupported: false, paired: false) == .needsAppleIntelligence)
        #expect(DraftNotice.for(hasSummary: false, writing: false, modelAvailable: true, languageSupported: true, paired: false) == .notWritten)
    }

    @Test func aRecordingKeepsTheLanguageItWasRecordedIn() throws {
        let folder = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Yogurt test recordings")
        var p = RecordingInProgress(id: "rec-1", startedAt: Date(timeIntervalSince1970: 100), audioFile: "rec-1.m4a")
        p.language = "de-DE"
        let again = try JSONDecoder().decode(RecordingInProgress.self, from: JSONEncoder().encode(p))
        #expect(again.language == "de-DE")
        let rec = again.recording(in: folder, title: "Walk", durationMs: 1000)
        #expect(rec.language == "de-DE")
        let saved = try JSONDecoder().decode(LocalRecording.self, from: JSONEncoder().encode(rec))
        #expect(saved.language == "de-DE")
        // one saved by an older build has none: the computer hears which it is
        let old = try JSONDecoder().decode(RecordingInProgress.self, from: Data(#"{"id":"a","startedAt":0,"audioFile":"a.m4a","myNotes":"","lines":[]}"#.utf8))
        #expect(old.language == nil)
    }
}
