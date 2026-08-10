# Guitar Pro test fixtures

These five files cover every Guitar Pro format the importer accepts, one per version:

| File | Format |
|---|---|
| `test_gp3.gp3` | Guitar Pro 3 |
| `test_gp4.gp4` | Guitar Pro 4 |
| `test_gp5.gp5` | Guitar Pro 5 |
| `test_gp6.gpx` | Guitar Pro 6 (compressed XML) |
| `test_gp7.gp`  | Guitar Pro 7 (zip container) |

They come from [rageagainsthepc/GuitarPro-to-Midi](https://github.com/rageagainsthepc/GuitarPro-to-Midi)
(MIT, © 2021 alexsteb), where they serve the same purpose. Using the fixtures that project
tests its own parser against is a fair check on ours, since ours reads the same formats
through alphaTab — the library those importers were ported from.

Used by `lib/server/guitarPro.test.ts`. They are multi-track real-world scores, which is
what makes them useful: they exercise track naming, tempo changes and track selection, not
just "does it parse".
