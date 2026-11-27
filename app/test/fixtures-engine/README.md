# Real-engine diarization fixtures

Two short mono speech clips, committed so the weekly diarization-engine workflow can prove that
`yogurt-audio decode` and NeMo-Speech.cpp's diarizer work without a fake engine. The workflow
concatenates them into one two-voice recording; a run passes only when the RTTM names exactly two
speakers on each backend (Linux Vulkan + CPU, macOS Metal + CPU).

Both clips come from the pinned NeMo-Speech.cpp checkout
(`c540e21167017d2e34444f2fc2d70649065dc500`). They are re-cut or copied as 16 kHz mono 16-bit PCM
WAVs.

| File | Length | Source | License |
| --- | --- | --- | --- |
| `clip1.wav` | 11 s | `test_files/asr/wav/test/jfk.wav`: an excerpt of President John F. Kennedy's inaugural address | Public domain (U.S. Government work) |
| `clip2.wav` | 6.12 s | `test_files/diar/ami_en2002d_2132.wav`, 51.22–57.34 s: one speaker (MEE073 in the matching RTTM) from the AMI Meeting Corpus excerpt | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), AMI Meeting Corpus |

The AMI excerpt's source file is 60 s of meeting EN2002d from the
[AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/) (CC BY 4.0), as documented in the
checkout's `test_files/diar/README.md`; `clip2.wav` was cut with:

```sh
ffmpeg -i ami_en2002d_2132.wav -af "atrim=start=51.22:end=57.34,asetpts=PTS-STARTPTS" \
  -ar 16000 -ac 1 -c:a pcm_s16le clip2.wav
```

`clip1.wav` is copied unchanged from the checkout. `SHA256SUMS` pins both committed files; the
workflow verifies them before running the engines.
