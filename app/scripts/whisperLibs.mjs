// The shared libraries whisper-server's build owns in resources/bin, so a rebuild replaces them and nothing else:
// on Linux the notes engine's allocator shim (libyogurt-bigalloc.so, #32) lives there too.
export const isWhisperLib = (name, win) => win ? name.endsWith('.dll') : /^lib(ggml|whisper).*\.so/.test(name)
