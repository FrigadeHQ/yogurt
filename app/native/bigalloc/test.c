// The shim's own check (scripts/native.mjs runs it after building): big blocks are mmapped, small ones aligned.
#include <stdint.h>
#include <stdio.h>
#include <string.h>

void *ggml_aligned_malloc(size_t size);
void ggml_aligned_free(void *ptr, size_t size);

#define CHECK(c) do { if (!(c)) { fprintf(stderr, "bigalloc: %s failed\n", #c); return 1; } } while (0)

int main(void) {
    // over 2 GiB, the size that crashes Electron's allocator; mmap only touches the pages written
    size_t big = (size_t)3 << 30;
    unsigned char *p = ggml_aligned_malloc(big);
    CHECK(p != NULL);
    CHECK((uintptr_t)p % 4096 == 0);
    p[0] = 1; p[big - 1] = 2;
    CHECK(p[0] == 1 && p[big - 1] == 2);
    ggml_aligned_free(p, big);

    unsigned char *s = ggml_aligned_malloc(1000);
    CHECK(s != NULL);
    CHECK((uintptr_t)s % 64 == 0);
    memset(s, 7, 1000);
    ggml_aligned_free(s, 1000);

    CHECK(ggml_aligned_malloc(0) == NULL);
    ggml_aligned_free(NULL, 0);
    puts("bigalloc: ok");
    return 0;
}
