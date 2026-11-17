# Assign unlabeled transcript lines to a speaker

Date: 2026-11-18
Status: approved design (approach A)

## Problem

Diarization leaves a few them-track lines unclaimed — gaps in the diarizer's turns, or
fragments whose words no turn covers. In the transcript they render under "Andere"
(Them) with no speaker, and there is no way to attribute them. Users want to assign
such a line to one of the meeting's speakers by hand.

## Feature

Every them-track line without a speaker key gets an inline menu (same affordance as
named lines' rename/merge menu) listing the meeting's speakers. Picking a speaker
assigns exactly that one line to them. One line per action; assigning again to another
speaker moves the line (no separate un-assign).

## Design

### Store (`src/main/store.ts`)

New method beside `renameSpeakers` / `mergeSpeakers`:

`assignSegment(meetingId: string, segmentId: number, key: string): boolean`

- Guards: the segment exists, belongs to the meeting, is track `them`, not hidden;
  `key` has a `meeting_speakers` row for the meeting. Otherwise false, nothing written.
- Effect: `speaker_key = key`, `speaker = <the key's display name>` — the name comes
  from any segment of that key that already shows one (same `nameOf` approach as
  `mergeSpeakers`).
- The existing `segments_au` trigger updates the search index; the name already exists
  in the meeting, so speaker colour order and voice profiles are untouched.

### IPC + preload

- `ipcMain.handle('transcript:assign-speaker', (id, segmentId, key))` beside
  rename/merge in `src/main/index.ts`, with the same argument validation; on success it
  fires the same `speakersChanged` refresh (main window + widget transcript events).
- Exposed as `window.yogurt.transcript.assignSpeaker(meetingId, segmentId, key)` in
  `src/preload/index.ts`, typed in `src/shared/types.ts`.

### Renderer (`src/renderer/src/components/Transcript.tsx`)

A them-track line without `speakerKey` renders its "Andere" label with the same
chevron affordance named lines have. Its menu lists the meeting's voices (the existing
`themVoices` list) as "assign to <name>" items; picking one calls `assignSpeaker` with
the segment's id. No rename/merge items there (the line has no key yet). Once assigned,
the line shows under its speaker and switches to the normal rename/merge menu.

### i18n

One new string: the menu's label/aria text (e.g. "Assign to speaker"). The menu items
need no new string — each item is just the speaker's existing name. The string goes into
every locale file like the rest of the transcript strings.

## Behaviour notes

- One line per action (user decision). Assigning is reversible by re-assigning.
- Assigned lines are keyed, and the diarizer's re-split only touches keyless rows, so a
  later re-diarization keeps the user's assignment.
- No new profile, colour, or notes-regeneration behaviour: the key and name already
  exist in the meeting.

## Non-goals

- Bulk or range assignment.
- Assigning `me`-track lines, or moving `me` content between speakers.
- Moving already-assigned lines between speakers (voice merge covers whole voices).
- Undo history (consistent with rename/merge, which have none).

## Testing

- Store test: `assignSegment` sets key and display name on the one segment, leaves
  neighbouring segments and other speakers untouched, returns false for an unknown
  segment or key, and the search index reflects the change.
- Renderer test: an "Andere" line shows the menu with the meeting's voices; picking one
  calls `assignSpeaker` with the segment id; the line then renders under that speaker.
  Follows the existing transcript component test patterns.
