# Transcript lab (optional, local)

For computers with memory and graphics to spare: after each meeting, extra open speech models read the recording again
and vote word by word. The combined transcript replaces the live one. The live lines and each model's reading are kept,
and any of them can be shown instead. It costs more computation, after the meeting. Nothing changes during the call, and
nothing leaves the computer.

It is off unless the profile folder holds a `transcript-lab.json` (Windows `%APPDATA%\Yogurt`, Mac
`~/Library/Application Support/Yogurt`). Yogurt doesn't download anything for it. You install the engines and the models.

## What it does

- **Stretches.** The meeting's saved lines are grouped into stretches of one speaker, up to 30 s each. Every model reads
  the same stretches.
- **Language.** A model that reports the language it heard (Qwen3-ASR) goes first. Each stretch is then read in that
  language by the other models set up for it, so a meeting in English and French works stretch by stretch.
- **Names and terms.** The meeting's attendees, their companies and the jargon list from Settings go to the models that
  take a vocabulary or context. In the vote, a word matching one of them gets one more vote.
- **Combining.** A pivot ROVER vote with equal votes. A reading in another alphabet than its language is left out.
  Yogurt's usual name respelling then runs on the result.
- **Replacing.** The combined text is shared back over the live lines, so times, speakers and hidden echoes stay.
- **In the transcript panel:**
  - a version picker (Live, Combined, each model);
  - Run models / Stop;
  - Compare: each stretch with its disputed words, every model's reading with its differences, and Fix.
- **Fixes.** A fix is your own text for a stretch. It is shown whatever the version, and it measures every model: the
  picker shows each version's error rate on your own meetings.

## Measured

Word error rate on meeting speech: AMI headset recordings in English, 20 minutes; SUMM-RE in French, 12 minutes from a
single meeting, so the French figures are indicative. Compute is in seconds per second of audio on a Ryzen AI Max+ 395
(Radeon 8060S, Vulkan), model loading included.

| | English | Compute | French | Compute |
|---|---|---|---|---|
| Live transcript (whisper large-v3-turbo q5) | 21.3% | 0.11 | 14.8% | 0.12 |
| Qwen3-ASR 1.7B alone | 14.3% | 0.14 | 7.7% | 0.16 |
| **Qwen3-ASR + Cohere Transcribe + Parakeet v3** | **12.0%** | **0.19** | | |
| Qwen3-ASR + Parakeet v3 + Granite Speech 4.1 | 11.3% | 0.35 | | |
| **Qwen3-ASR + Nemotron 3.5 Transcribe + Canary 1B v2** | | | **7.0%** | **0.30** |

The sets were chosen by scoring every combination of nine models for errors against compute. Rankings held when the
material was split in two halves. Two findings:

- **A strong model alone gets most of the gain.** Three models of different families get a little more.
- **More is not better.** Weak voters outvote a strong one: five models in French gave 12.8%. The best single model in
  both languages, Nemotron 3.5, adds nothing to the English set for its cost.

A language model settling the disputed words (Gemma 4 26B) did not lower errors either, so it is not part of the lab.

## Setup

1. **Engines.** Build them from source:
   - [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (MIT) runs Whisper, Qwen3-ASR, Cohere, Parakeet,
     Canary and Granite;
   - [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) (Apache-2.0) runs Nemotron 3.5 Transcribe.
2. **Models.** Download the GGUF files of the models you want. Check each one's SHA-256 against the one its Hugging Face
   page lists.
3. **ffmpeg.** It decodes the recordings.
4. **Config.** Write `transcript-lab.json`:

```json
{
  "ffmpeg": "/path/to/ffmpeg",
  "engines": { "transcribe": "/path/to/transcribe-cli", "nemo": "/path/to/nemo-speech" },
  "languages": ["en", "fr"],
  "auto": true,
  "mode": "vote",
  "models": [
    { "id": "qwen3-asr-1.7b", "label": "Qwen3-ASR 1.7B", "engine": "transcribe", "detects": true, "languages": ["en", "fr"],
      "path": "/models/Qwen3-ASR-1.7B-F16.gguf", "takes": ["vocabulary", "context"] },
    { "id": "cohere-transcribe", "label": "Cohere Transcribe", "engine": "transcribe", "languages": ["en"],
      "path": "/models/cohere-transcribe-03-2026-F16.gguf", "takes": ["language"] },
    { "id": "parakeet-v3", "label": "Parakeet v3", "engine": "transcribe", "languages": ["en"],
      "path": "/models/parakeet-tdt-0.6b-v3-F16.gguf", "takes": [] },
    { "id": "nemotron-3.5", "label": "Nemotron 3.5 Transcribe", "engine": "nemo", "languages": ["fr"],
      "path": "/models/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-AD-IQ4_NL.gguf", "takes": ["language"] },
    { "id": "canary-1b-v2", "label": "Canary 1B v2", "engine": "transcribe", "languages": ["fr"],
      "path": "/models/canary-1b-v2-F16.gguf", "takes": ["language"] }
  ]
}
```

Notes on the fields:
- **`takes`** is what a model is told besides the audio: `language`, `vocabulary`, `context`.
- **`languages`** limits a model to the stretches heard in those languages.
- **`mode`** is `vote`, `pick` (the one reading closest to the others) or `best` (the highest `weight`). Give one mode,
  or one per language: `{"en": "vote", "fr": "best"}`.
- **`combine: false`** runs a model to compare only, outside the vote.
- **`auto: false`** reads meetings again only on Run models.
- **A broken file** turns the lab off, and the log says why.
