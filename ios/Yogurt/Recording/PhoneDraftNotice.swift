import SwiftUI
import YogurtKit

/// The Summary pane of a meeting recorded on this iPhone while it has no notes yet: they're being written, the
/// computer will write them, or this iPhone can't.
struct PhoneDraftNotice: View {
    let meetingId: String
    @Environment(AppModel.self) private var model
    private var drafts: PhoneDrafts { .shared }

    var body: some View {
        let locale = model.store.localRecordings().first(where: { $0.id == meetingId })?.spokenLocale ?? Spoken.current
        let reads = AppleIntelligence.reads(locale)
        let available = AppleIntelligence.modelAvailable && reads
        let notice = DraftNotice.for(hasSummary: false, writing: drafts.isWriting(meetingId), modelAvailable: AppleIntelligence.modelAvailable,
                                     modelPreparing: AppleIntelligence.preparing, languageSupported: reads, paired: model.engine.status != .notPaired && !model.store.staysOnPhone(meetingId))
        VStack(alignment: .leading, spacing: 12) {
            switch notice {
            case .writing:
                HStack(spacing: 10) {
                    ProgressView()
                    Text(S.writingNotes).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                }
            case .computerWillWrite:
                Label(S.notesFromComputer, systemImage: "laptopcomputer").font(.subheadline).foregroundStyle(Theme.muted)
            case .needsAppleIntelligence:
                Label(S.notesNeedAppleIntelligence, systemImage: "iphone").font(.subheadline).foregroundStyle(Theme.muted)
            case .languageNotSupported:
                Label(S.notesNeedLanguage(SpokenLanguage.name(of: locale, in: .current)), systemImage: "iphone")
                    .font(.subheadline).foregroundStyle(Theme.muted)
            case .modelPreparing:
                Label(S.notesWhenModelReady, systemImage: "iphone").font(.subheadline).foregroundStyle(Theme.muted)
            case .notWritten, nil:
                Text(S.notesNotWritten).font(.subheadline).foregroundStyle(Theme.muted)
                if available {
                    Button(S.tryAgain) { drafts.write(meetingId, model: model) }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                }
            }
        }
        .animation(.easeOut(duration: 0.2), value: notice)
    }
}
