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

/// Questions asked and their answers. Saved beside the meetings, so they stay until New chat (or Unpair) clears them:
/// iOS restarting Yogurt in the background never takes them away.
@MainActor @Observable
final class AskSession {
    static let shared = AskSession(file: URL.applicationSupportDirectory.appending(path: "Yogurt/ask.json"))

    enum Where: Equatable {
        /// on the same Wi-Fi as the computer, which answers
        case computer
        /// Apple's model on this iPhone
        case phone
        /// neither: no computer nearby and no Apple Intelligence here
        case nowhere
    }

    struct Turn: Identifiable, Codable {
        enum State: Codable { case answering, answered(AskAnswer), failed }
        var id = UUID()
        let question: String
        let scope: AskScope?
        /// "All meetings", a folder's name, "This meeting"
        let scopeName: String
        var state: State = .answering
    }

    /// each conversation's turns: Home's, and one per meeting asked about from its note
    private var conversations: [String: [Turn]] = [:] { didSet { save() } }
    @ObservationIgnored private var reader: AskReader?
    @ObservationIgnored private let file: URL

    init(file: URL) {
        self.file = file
        let saved = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode([String: [Turn]].self, from: $0) } ?? [:]
        // a question still being answered when Yogurt stopped can be asked again
        conversations = saved.mapValues { $0.map { t in
            var t = t
            if case .answering = t.state { t.state = .failed }
            return t
        } }
    }

    func turns(_ key: String) -> [Turn] { conversations[key] ?? [] }

    /// New chat: this conversation starts over. Only ever from a tap.
    func newChat(_ key: String) { conversations[key] = nil }

    /// Unpaired: the computer's answers and excerpts don't stay on screen, or on this iPhone.
    func clear() {
        conversations = [:]
        try? FileManager.default.removeItem(at: file)
    }

    private func save() {
        guard !conversations.isEmpty else { try? FileManager.default.removeItem(at: file); return }
        try? JSONEncoder().encode(conversations).write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
    }

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
