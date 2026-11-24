# Crypto test vectors

Shared by the desktop tests (`app/test/companionCpace.test.ts`, `app/test/companionNoise.test.ts`) and the
YogurtKit Swift tests, so both sides are checked against the same published values.

## noise-kk-vectors.json

Only the `Noise_KK_25519_ChaChaPoly_BLAKE2b` entries, copied unchanged (empty `psks` fields dropped) and tagged with
`source`:

- cacophony: https://github.com/haskell-cryptography/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/vectors/cacophony.txt
  — public domain (The Unlicense).
- snow: https://github.com/mcginty/snow/blob/8ac60f51cfe3e010c84f0a454cc575ad9204fa12/tests/vectors/snow.txt
  — Apache-2.0 (snow is dual licensed Apache-2.0 / MIT).

Format: the Noise test-vector format. `init_*`/`resp_*` are private keys, `messages[0..1]` are the handshake,
the rest are transport messages alternating initiator, responder.

## cpace-ristretto255-vectors.json

From draft-irtf-cfrg-cpace-21 (April 2026), Appendix B.3 "Test vector for CPace using group ristretto255 and hash
SHA-512", decoded from the draft's own BASE64 JSON blocks (B.3.1.1, B.3.9, B.3.11.1) and cross-checked against the
hex listings. https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt — IETF Trust, BCP 78 / Revised BSD
licence for code components.

`ISK_IR` is the initiator/responder transcript (the one Yogurt uses); `ISK_SY` the ordered-concatenation one.
`invalidPoints` must make `scalar_mult_vfy` fail (a non-canonical encoding and the identity).
