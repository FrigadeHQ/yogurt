import Foundation
import FoundationModels
import YogurtKit

/// Apple's on-device model (Foundation Models) as YogurtKit's TextModel. Each prompt gets a session of its own, so
/// one part of a long meeting never fills the model's memory for the next.
struct AppleModel: TextModel {
    /// summarising the person's own meeting is a content transformation: the looser guardrails are meant for it
    private static let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)

    func respond(to prompt: String, maxTokens: Int) async throws -> String {
        let session = LanguageModelSession(model: Self.model,
                                           instructions: "You write clear, accurate meeting notes. You only use what is in the transcript and notes you are given.")
        do {
            return try await session.respond(to: prompt, options: GenerationOptions(temperature: 0.3, maximumResponseTokens: maxTokens)).content
        } catch let e as LanguageModelSession.GenerationError {
            switch e {
            case .exceededContextWindowSize: throw TextModelError.tooLong
            case .guardrailViolation, .refusal: throw TextModelError.refused
            default: throw e
            }
        }
    }
}

enum AppleIntelligence {
    /// The model is on this iPhone, turned on, ready, and reads this language.
    static func available(for locale: Locale = .current) -> Bool { modelAvailable && reads(locale) }

    /// The model is on this iPhone, turned on and ready, whatever the language.
    static var modelAvailable: Bool { SystemLanguageModel.default.availability == .available }

    static func reads(_ locale: Locale) -> Bool { SystemLanguageModel.default.supportsLocale(locale) }

    /// Turned on but still downloading: notes are written once it's ready.
    static var preparing: Bool { SystemLanguageModel.default.availability == .unavailable(.modelNotReady) }

    static func summarizer(locale: Locale = .current) -> MapReduceSummarizer {
        MapReduceSummarizer(model: AppleModel(), language: languageName(locale))
    }
}
