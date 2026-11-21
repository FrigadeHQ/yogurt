import Foundation
import FoundationModels
import YogurtKit

/// Apple's on-device model (Foundation Models) as YogurtKit's TextModel. Each prompt gets a session of its own, so
/// one part of a long meeting never fills the model's memory for the next.
struct AppleModel: TextModel {
    func respond(to prompt: String, maxTokens: Int) async throws -> String {
        let session = LanguageModelSession(instructions: "You write clear, accurate meeting notes. You only use what is in the transcript and notes you are given.")
        do {
            return try await session.respond(to: prompt, options: GenerationOptions(temperature: 0.3, maximumResponseTokens: maxTokens)).content
        } catch let e as LanguageModelSession.GenerationError {
            if case .exceededContextWindowSize = e { throw TextModelError.tooLong }
            throw e
        }
    }
}

enum AppleIntelligence {
    /// The model is on this iPhone, turned on, ready, and reads this language.
    static func available(for locale: Locale = .current) -> Bool {
        let model = SystemLanguageModel.default
        return model.availability == .available && model.supportsLocale(locale)
    }

    static func summarizer(locale: Locale = .current) -> MapReduceSummarizer {
        MapReduceSummarizer(model: AppleModel(), language: languageName(locale))
    }
}
