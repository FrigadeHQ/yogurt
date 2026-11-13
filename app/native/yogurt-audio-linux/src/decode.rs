//! yogurt-audio decode --in FILE --out WAV: a meeting's Ogg Opus recording as 16 kHz mono 16-bit PCM,
//! for the diarizer. The file's timeline is meeting time, so the WAV is too.

#[cfg(test)]
use crate::ogg_opus::OpusWriter;
use crate::resample;
use std::io::Write;
use std::path::Path;

pub fn decode_file(input: &Path, output: &Path) -> i32 {
    let mut pcm = Vec::new();
    if input.extension().and_then(|e| e.to_str()) == Some("ogg") {
        // the recorder writes Ogg Opus at 48 kHz mono; resample::Down3 takes it to 16 kHz below
        let sink = |samples: &[f32]| -> std::io::Result<()> { pcm.extend_from_slice(samples); Ok(()) };
        if crate::ogg_opus::decode(input, sink).is_err() { eprintln!("unsupported-input"); return 1 }
    } else {
        // an m4a on Windows/Linux (a cross-platform import) is not decoded in v1
        eprintln!("unsupported-input");
        return 1
    }
    let wav = match write_wav(&pcm) { Ok(w) => w, Err(e) => { eprintln!("write failed: {e}"); return 1 } };
    match std::fs::File::create(output).and_then(|mut f| f.write_all(&wav)) {
        Ok(()) => 0,
        Err(e) => { eprintln!("write failed: {e}"); 1 }
    }
}

/// 16 kHz mono s16le WAV; the recorder's Ogg Opus is 48 kHz, so it goes through the recorder's own resampler
fn write_wav(samples: &[f32]) -> std::io::Result<Vec<u8>> {
    let mut down = resample::Down3::new();
    let mut sixteen = Vec::new();
    down.process(samples, &mut sixteen);
    let n = sixteen.len() * 2;
    let mut b = Vec::with_capacity(44 + n);
    b.extend_from_slice(b"RIFF"); b.extend_from_slice(&(36 + n as u32).to_le_bytes()); b.extend_from_slice(b"WAVE");
    b.extend_from_slice(b"fmt "); b.extend_from_slice(&16u32.to_le_bytes()); b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); b.extend_from_slice(&16_000u32.to_le_bytes());
    b.extend_from_slice(&32_000u32.to_le_bytes()); b.extend_from_slice(&2u16.to_le_bytes()); b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data"); b.extend_from_slice(&(n as u32).to_le_bytes());
    for s in &sixteen { b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes()); }
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_ogg_opus_to_a_16k_mono_wav() {
        let dir = std::env::temp_dir().join(format!("yogurt-decode-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ogg = dir.join("them.ogg");
        let mut w = OpusWriter::create(&ogg).unwrap();
        // 2 seconds of a quiet sine at 48 kHz
        let samples: Vec<f32> = (0..96_000).map(|i| (i as f32 * 440.0 * 2.0 * std::f32::consts::PI / 48_000.0).sin() * 0.05).collect();
        w.write(&samples).unwrap();
        w.finish().unwrap();
        let wav = dir.join("them.wav");
        assert_eq!(decode_file(&ogg, &wav), 0);
        let bytes = std::fs::read(&wav).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(bytes[22..24].try_into().unwrap()), 1);
        let data = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        // 2 s of audio at 16 kHz mono 16-bit, with a small tolerance for the encoder's pre-skip
        assert!((data as i64 - 2 * 16_000 * 2).abs() < 4_000, "data bytes {data}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
