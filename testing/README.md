# CSSS local test suite

This folder is gitignored. Place fixtures here before running tests.

## Fixtures

| File | Purpose |
|------|---------|
| `test.pka` | **Starter/unconfigured** Packet Tracer submission (intentional). Decrypts and grades, but positive checks fail (e.g. `hostname Router` instead of `PIX-NYC-R1`). Expect ~0/390 with only the `BOS-PC1` penalty check firing. |
| `lab.conf` | Lab `tstrnd` with full check list (answer key) |

To run **full score assertions** (390/390, all positive checks pass), replace `test.pka` with a completed answer-key submission. The integration test detects this automatically and applies stricter checks only when the score is perfect.

## Commands

```bash
npm test          # all unit + integration tests
npm run test:perf # decrypt/grade timing report only
```

Tests skip PKA integration cases automatically if `test.pka` or `lab.conf` is missing.
