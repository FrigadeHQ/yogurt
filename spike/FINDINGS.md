# Telling voices apart on one mic: findings (spike, not shipped)

Throwaway research. Nothing here is wired into the app; branch `spike/voice-diarization` stays local.

## Context
- Today: mic = You, the other side = Them or a name read from the call app. An earlier Mac-only attempt (FluidAudio plus model name guessing) was taken out; any new take must work on Mac, Windows and Linux and never guess names.
- The gap: an in-person meeting on one mic labels every line "You" (`notes/enhance.ts` `oneMic()`).

## Recommended stack
| Part | Choice | Licence | Size |
|---|---|---|---|
| Runtime | sherpa-onnx-node 2.0.1 (N-API, prebuilt Mac/Win/Linux) | Apache-2.0 | 23–40 MB per platform |
| Segmentation | pyannote segmentation-3.0 ONNX | MIT | 5.7 MB |
| Embedding | 3D-Speaker ERes2Net VoxCeleb | Apache-2.0 | 26.5 MB |
| Faster embedding | CAM++ zh/en advanced (2.8x faster, a bit less accurate) | Apache-2.0 | 28 MB |

## Measured (M1 Max, one thread; 3 public AMI meetings, CC-BY-4.0, one far-field mic, 4 people each)
- Hybrid (segmentation turns, one embedding per turn, average-linkage clustering, small clusters folded in): DER 26.4 / 25.2 / 24.4% (18.3 / 16.4 / 17.3 with 0.25 s collar). pyannote 3.1 published: 22.7 on AMI one-mic.
- sherpa built-in clustering, speaker count given: 39.0 / 27.8 / 24.2.
- Speed ~0.15–0.17x real time on one core (2.5–4 min for a 17–25 min meeting); RAM ~0.5–0.8 GB.
- Naming from 20 s voice prints: turns of 4 s or more named right 94–100%; under 2 s near chance.
- Live online clustering: 8–68 "voices" for 4 people, so not usable live. It runs after the meeting.
- Whole whisper chunks: 51–88% right; lines must be cut at voice changes, so whisper word timestamps are needed.
- Weak spot: 4-men meeting found 2 of 4 voices (two barely spoke). Thresholds tuned on one meeting, then held fixed on the other two.

## How it would fit
- `app/src/main/voices/` in a utility process, run after `transcribed(id)` on the mic track when `oneMic()` is true.
- `segments.speaker`, plus a new `voice` column and a `voice_prints` table.
- Names, in order: your own print (from past calls' mic track), prints saved where call-app names were certain, calendar attendees; else Speaker N, with rename-to-save.
- Call-app names always win; voices only fill lines `nameFor()` leaves null.

## Ruled out
reverb and DiariZen weights (non-commercial), tinydiarize (English only, turn marks only), Nemotron-3-Diarization (OpenMDW, 100M params, GPU-first), Sortformer (4 speakers max, NVIDIA licence), FluidAudio (Mac only).

## Open questions
1. Bring voice splitting back for room meetings only?
2. Speaker N when no print matches, or keep "You"?
3. Learn voice prints automatically (biometric, on-device)?
4. Should voices ever replace "Them" on calls?
5. Change whisper-server to return word timestamps?
6. CC-BY-4.0 models acceptable with a licence file, or only MIT/Apache?

Spike scripts and checksums: `spike/`, `spike/models.sha256`. Raw results: `spike/out/` (git-ignored).
