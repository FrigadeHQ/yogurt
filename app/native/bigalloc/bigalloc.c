// Linux only (#32). Loaded into the notes engine with LD_PRELOAD (src/main/engine.ts), never into the app itself.
//
// Electron's own allocator (PartitionAlloc, exported as malloc from the Electron binary) deliberately crashes the
// process (SIGILL) on a single allocation over about 2 GiB. llama.cpp makes allocations that big when the model runs on
// the processor: the repacked weights (CPU_REPACK, 2.1 GB for Gemma 4 E4B, 13 GB for 26B) and a big context.
// They all go through ggml_aligned_malloc in libggml-base.so, which calls it through its PLT, so this copy wins.
// Big blocks are mmapped (what glibc would do); the rest go to posix_memalign like ggml's own Linux code.
// Recheck after a node-llama-cpp update: this relies on ggml keeping these two functions, exported, with this signature.
#define _GNU_SOURCE
#include <stdlib.h>
#include <sys/mman.h>

#define BIG ((size_t)256 << 20)

void *ggml_aligned_malloc(size_t size) {
    if (size == 0) return NULL;
    if (size >= BIG) {
        // page aligned, which covers ggml's 64 bytes
        void *p = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        return p == MAP_FAILED ? NULL : p;
    }
    void *p = NULL;
    return posix_memalign(&p, 64, size) == 0 ? p : NULL;
}

// ggml frees with the size it allocated (its Mac code relies on that too), so the size says which way it went
void ggml_aligned_free(void *ptr, size_t size) {
    if (!ptr) return;
    if (size >= BIG) munmap(ptr, size);
    else free(ptr);
}
