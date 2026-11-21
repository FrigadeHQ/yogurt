import Foundation
import FoundationModels
import YogurtKit

/// Apple's on-device model for Ask, as YogurtKit's TextModel. A session per question, like the notes writer's.
struct AppleAskModel: TextModel {
    func respond(to prompt: String, maxTokens: Int) async throws -> String {
        let session = LanguageModelSession(instructions: "You answer questions about the person's meetings, only from the parts of them you are given, citing each with its number.")
        do {
            return try await session.respond(to: prompt, options: GenerationOptions(temperature: 0.2, maximumResponseTokens: maxTokens)).content
        } catch let e as LanguageModelSession.GenerationError {
            if case .exceededContextWindowSize = e { throw TextModelError.tooLong }
            throw e
        }
    }
}

/// Finds passages on a SQLite connection of its own, so a search over every transcript never holds up the screen.
actor AskReader {
    private let store: Store
    let url: URL
    init(url: URL) throws { self.url = url; store = try Store(url: url) }

    func passages(_ question: String, scope: AskScope?) -> [AskPassage] {
        LocalAsk.passages(for: question, scope: scope, in: store)
    }
}

/// Questions asked this session and their answers. Kept in memory only: they go when Yogurt quits.
@MainActor @Observable
final class AskSession {
    static let shared = AskSession()

    enum Where: Equatable {
        /// on the same Wi-Fi as the computer, which answers
        case computer
        /// Apple's model on this iPhone
        case phone
        /// neither: no computer nearby and no Apple Intelligence here
        case nowhere
    }

    struct Turn: Identifiable {
        enum State { case answering, answered(AskAnswer), failed }
        let id = UUID()
        let question: String
        let scope: AskScope?
        /// "All meetings", a folder's name, "This meeting"
        let scopeName: String
        var state: State = .answering
    }

    /// each conversation's turns: Home's, and one per meeting asked about from its note
    private var conversations: [String: [Turn]] = [:]
    @ObservationIgnored private var reader: AskReader?

    func turns(_ key: String) -> [Turn] { conversations[key] ?? [] }

    /// Unpaired: the computer's answers and excerpts don't stay on screen.
    func clear() { conversations = [:] }

    var busy: Bool { conversations.values.contains { $0.contains { if case .answering = $0.state { true } else { false } } } }

    /// Apple's model can answer here. DEBUG -previewNoAppleIntelligence YES shows the screen without it.
    static var onThisPhone: Bool {
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "previewNoAppleIntelligence") { return false }
        #endif
        return AppleIntelligence.available()
    }

    static func whereAnswered(_ model: AppModel) -> Where {
        if case .connected = model.engine.status { return .computer }
        return AskSession.onThisPhone ? .phone : .nowhere
    }

    func ask(_ question: String, scope: AskScope?, scopeName: String, key: String, model: AppModel) {
        let turn = Turn(question: question, scope: scope, scopeName: scopeName)
        conversations[key, default: []].append(turn)
        run(turn.id, key: key, model: model)
    }

    func retry(_ id: UUID, key: String, model: AppModel) {
        guard let i = conversations[key]?.firstIndex(where: { $0.id == id }) else { return }
        conversations[key]![i].state = .answering
        run(id, key: key, model: model)
    }

    private func run(_ id: UUID, key: String, model: AppModel) {
        guard let turn = conversations[key]?.first(where: { $0.id == id }) else { return }
        Task {
            let state: Turn.State
            do { state = .answered(try await answer(turn, model: model)) } catch { state = .failed }
            if let i = conversations[key]?.firstIndex(where: { $0.id == id }) { conversations[key]![i].state = state }
        }
    }

    private func answer(_ turn: Turn, model: AppModel) async throws -> AskAnswer {
        // a recording made here that the computer doesn't have yet: only this iPhone can answer about it
        let notSent = Set(model.store.localRecordings().filter { $0.uploadedAt == nil }.map(\.id))
        let phoneOnly = turn.scope?.meetingIds.map { !$0.isEmpty && $0.allSatisfy(notSent.contains) } ?? false
        if case .connected = model.engine.status, !phoneOnly {
            do {
                return AskAnswer(remote: try await model.engine.ask(turn.question, scope: turn.scope))
            } catch {
                // the computer went away mid-question: this iPhone answers when it can
                guard AskSession.onThisPhone else { throw error }
            }
        }
        guard AskSession.onThisPhone else { throw AskError.noAnswer }
        let passages = try await reader(for: model).passages(turn.question, scope: turn.scope)
        return try await LocalAsk(model: AppleAskModel()).answer(question: turn.question, passages: passages)
    }

    /// one per meetings file (the sample meetings have their own)
    private func reader(for model: AppModel) throws -> AskReader {
        let url = model.storeFolder.appending(path: "yogurt.sqlite")
        if let reader, reader.url == url { return reader }
        let r = try AskReader(url: url)
        reader = r
        return r
    }
}
