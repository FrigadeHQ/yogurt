#!/bin/sh
# Builds the Mac helpers (Apple Silicon) into resources/bin: yogurt-mac (calendar, mic apps, names from calls),
# yogurt-audio (recording), yogurt-mcp (AI apps reading meetings), whisper-server (speech to text, built from a pinned
# whisper.cpp) and nemo-speech (speaker diarization, built from a pinned NeMo-Speech.cpp).
# Skipped off a Mac, or when a helper is newer than its source.
set -e
[ "$(uname)" = "Darwin" ] || exit 0
cd "$(dirname "$0")/.."
mkdir -p resources/bin resources/lib
for name in yogurt-mac yogurt-audio yogurt-mcp; do
  src=native/$name/main.swift
  plist=native/$name/Info.plist
  out=resources/bin/$name
  if [ -f "$out" ] && [ "$out" -nt "$src" ] && [ "$out" -nt "$plist" ]; then continue; fi
  # the plist is embedded so the system's Calendar, Microphone and audio recording prompts have Yogurt's words.
  # 14.4: Core Audio process taps arrived in 14.2, their permission prompt in 14.4
  xcrun swiftc -O -target arm64-apple-macos14.4 "$src" -o "$out" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist"
  echo "built $out"
done

# whisper-server: whisper.cpp at a pinned commit, Metal on, the Metal shaders embedded so it is one file.
# The clone and build live in native/.whisper-build (gitignored); only the finished program is copied out.
# native/whisper-server.patch is applied on top: with VAD on, a chunk with no speech in it crashed the server.
# It also makes whisper pick a discrete graphics card over an integrated one (Windows and Linux; a Mac has one).
WHISPER_TAG=v1.9.5
WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
out=resources/bin/whisper-server
if [ ! -f "$out" ] || [ "$0" -nt "$out" ] || [ native/whisper-server.patch -nt "$out" ]; then
  CMAKE=/opt/homebrew/bin/cmake
  [ -x "$CMAKE" ] || CMAKE=$(command -v cmake) || { echo "cmake is needed to build whisper-server (brew install cmake)" >&2; exit 1; }
  dir=native/.whisper-build
  if [ ! -d "$dir/.git" ]; then
    git clone --quiet https://github.com/ggml-org/whisper.cpp.git "$dir"
  fi
  git -C "$dir" checkout --quiet --force "$WHISPER_COMMIT"
  [ "$(git -C "$dir" rev-parse HEAD)" = "$WHISPER_COMMIT" ] || { echo "whisper.cpp is not at $WHISPER_COMMIT" >&2; exit 1; }
  git -C "$dir" apply "$PWD/native/whisper-server.patch"
  "$CMAKE" -S "$dir" -B "$dir/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_TESTS=OFF \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.4 >/dev/null
  "$CMAKE" --build "$dir/build" --config Release --target whisper-server -j "$(sysctl -n hw.ncpu)" >/dev/null
  cp "$dir/build/bin/whisper-server" "$out"
  echo "built $out"
fi

# Silero VAD for whisper-server (MIT, ggml-org/whisper-vad at a pinned commit): whisper only reads the stretches with
# speech in them, so a click or a notification on a quiet track is never turned into words. Checked against its sha256.
VAD_URL=https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin
VAD_SHA256=2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987
vad=resources/vad/ggml-silero-v6.2.0.bin
if [ ! -f "$vad" ] || [ "$(shasum -a 256 "$vad" | cut -d' ' -f1)" != "$VAD_SHA256" ]; then
  mkdir -p resources/vad
  curl -sSfL --retry 8 --retry-delay 15 --retry-all-errors -o "$vad.part" "$VAD_URL"
  [ "$(shasum -a 256 "$vad.part" | cut -d' ' -f1)" = "$VAD_SHA256" ] || { rm -f "$vad.part"; echo "the VAD model's checksum is wrong" >&2; exit 1; }
  mv "$vad.part" "$vad"
  echo "fetched $vad"
fi

# nemo-speech: NeMo-Speech.cpp at a pinned commit, Metal on, the Metal shaders embedded so it is one file. Its CMake target
# is nemo_speech_cli (the program is named nemo-speech); ggml comes from its llama.cpp submodule, and SentencePiece (the ASR
# engine's tokenizer) is built statically into the checkout's .deps, where its CMake looks by default. Windows and Linux
# build it in nemo-build.mjs (Vulkan there). YOGURT_NO_NEMO=1 leaves it out.
NEMO_COMMIT=c540e21167017d2e34444f2fc2d70649065dc500
NEMO_SENTENCEPIECE_COMMIT=31646a467d2051eb904e0b45de3a73e91fe1c1e3
out=resources/bin/nemo-speech
if [ -n "$YOGURT_NO_NEMO" ]; then echo "nemo-speech left out (YOGURT_NO_NEMO=1)"
elif [ ! -f "$out" ] || [ "$0" -nt "$out" ]; then
  CMAKE=/opt/homebrew/bin/cmake
  [ -x "$CMAKE" ] || CMAKE=$(command -v cmake) || { echo "cmake (3.26 or newer) is needed to build nemo-speech (brew install cmake)" >&2; exit 1; }
  dir=native/.nemo-build
  if [ ! -d "$dir/.git" ]; then git clone --quiet https://github.com/NVIDIA/NeMo-Speech.cpp "$dir"; fi
  git -C "$dir" checkout --quiet --force "$NEMO_COMMIT"
  [ "$(git -C "$dir" rev-parse HEAD)" = "$NEMO_COMMIT" ] || { echo "NeMo-Speech.cpp is not at $NEMO_COMMIT" >&2; exit 1; }
  git -C "$dir" submodule update --init --depth 1 --force llama.cpp
  # SentencePiece statically: the same commit and cmake flags as the checkout's scripts/build_sentencepiece_static.sh,
  # minus its Ninja dependency, so cmake plus the Xcode tools is enough
  sp=$dir/.deps/sentencepiece
  if [ ! -f "$sp/lib/libsentencepiece.a" ]; then
    rm -rf "$dir/.deps/sentencepiece-src" "$dir/.deps/sentencepiece-build"
    git clone --quiet --depth 1 https://github.com/google/sentencepiece.git "$dir/.deps/sentencepiece-src"
    git -C "$dir/.deps/sentencepiece-src" fetch --quiet --depth 1 origin "$NEMO_SENTENCEPIECE_COMMIT"
    git -C "$dir/.deps/sentencepiece-src" checkout --quiet --force "$NEMO_SENTENCEPIECE_COMMIT"
    "$CMAKE" -S "$dir/.deps/sentencepiece-src" -B "$dir/.deps/sentencepiece-build" -DCMAKE_BUILD_TYPE=Release \
      -DSPM_BUILD_TEST=OFF -DSPM_ENABLE_SHARED=OFF -DSPM_ENABLE_TCMALLOC=OFF >/dev/null
    "$CMAKE" --build "$dir/.deps/sentencepiece-build" --config Release --target sentencepiece-static -j "$(sysctl -n hw.ncpu)" >/dev/null
    mkdir -p "$sp/lib" "$sp/include"
    cp "$dir/.deps/sentencepiece-build/src/libsentencepiece.a" "$sp/lib/libsentencepiece.a"
    cp "$dir/.deps/sentencepiece-src/src/sentencepiece_processor.h" "$sp/include/sentencepiece_processor.h"
  fi
  # flags verified at the pin: the option() names in its CMakeLists.txt and the metal-asr preset in its CMakePresets.json
  "$CMAKE" -S "$dir" -B "$dir/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DNEMO_SPEECH_BUILD_TESTS=OFF -DNEMO_SPEECH_BUILD_EXAMPLES=OFF -DNEMO_SPEECH_BUILD_TOOLS=OFF \
    -DNEMO_SPEECH_BUILD_TTS=OFF -DNEMO_SPEECH_BUILD_NMT=OFF -DNEMO_SPEECH_BUILD_HTTP=OFF \
    -DNEMO_SPEECH_GGML_PATCHED=OFF -DGGML_NATIVE=OFF \
    -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=14.4 >/dev/null
  "$CMAKE" --build "$dir/build" --config Release --target nemo_speech_cli -j "$(sysctl -n hw.ncpu)" >/dev/null
  cp "$dir/build/bin/nemo-speech" "$out"
  echo "built $out"
fi
