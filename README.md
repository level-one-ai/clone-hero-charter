# Charter

A self-hosted web tool for charting rhythm-game songs. Import audio plus a reference
`.mid` or `.chart`, edit the chart against a waveform and a scrolling 5-lane note
highway, and export a Clone Hero song folder as a zip.

No database — projects are plain folders on disk with a `songs.json` index.

---

## What it exports

A zip containing exactly one folder, named `Artist - Title (Charter)` — the Clone Hero
library convention — that drops straight into Clone Hero's `Songs/` directory:

```
ERRA - Gore of Being (enerbewow)/
  notes.chart     the chart
  song.ogg        the audio (transcoded from your upload)
  album.jpg       cover art, if you supplied one (.png also works)
  song.ini        metadata — this, not the chart, is what the song browser reads
```

The charter's name identifies whose chart it is when several people have charted the
same song. Set it on the New Song screen or in the editor's **Song** panel, which
previews the exact folder name as you type. With no charter set, the parentheses are
omitted entirely.

**Platform note.** This targets Clone Hero on Windows, Mac, Linux, Android and Quest.
Clone Hero does not run on Xbox 360. Xbox 360 customs are signed CON/STFS packages
containing `.mid` + `.mogg` + a DTA file, built with a separate toolchain (C3 CON
Tools and an RSA signing key) — this app does not produce them.

**Audio format.** Exports transcode to OGG Vorbis by default — the community standard,
and roughly ten times smaller than a lossless WAV. Clone Hero also loads `.wav`, `.mp3`
and `.opus`, so the export dialog has a **Keep the original audio** toggle when you'd
rather ship `song.wav` untouched. If ffmpeg is unavailable or cannot read your file,
the export falls back to the original audio and tells you it did.

---

## Local development

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>.

In development, song projects are written to `./data` in the repo (git-ignored). Set
`DATA_DIR` to put them somewhere else:

```bash
DATA_DIR=/srv/charter-data npm run dev
```

**ffmpeg is optional locally.** Without it, `song_length` still works for WAV files
(read straight from the RIFF header) and exports package the original audio with a
warning. Install it to get OGG transcoding and duration detection for MP3/OGG input:

```bash
# macOS
brew install ffmpeg
# Debian/Ubuntu
sudo apt install ffmpeg
```

### Other commands

| Command | Does |
|---|---|
| `npm run build` | Production build |
| `npm start` | Serve the production build (runs the standalone bundle, same as the container does — `next start` does not support `output: 'standalone'`) |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check without emitting |

---

## Docker

```bash
docker compose up --build
```

The app listens on port 3000 and stores projects in the `charter-data` named volume
mounted at `/data`. The image includes ffmpeg.

To confirm your projects actually survive a restart:

```bash
docker compose down && docker compose up -d
# your songs should still be listed at http://localhost:3000
```

---

## Deploying with Coolify

1. **New Resource → Application**, pointed at this Git repository.
2. **Configuration → General → Build Pack: `Dockerfile`.**
   This matters. **Nixpacks will not work**: it ignores the `Dockerfile` entirely, so
   it installs no ffmpeg (exports silently fall back to the original audio) and none
   of the environment below is applied — including the `HOSTNAME` pin, whose absence
   produces a Bad Gateway. See the troubleshooting note below.
3. **Ports Exposes:** `3000`.
4. **Storages → + Add → Volume Mount:**
   - Name: `charter-data`
   - Destination Path: `/data`

   Without this, every redeploy destroys all your song projects — the container
   filesystem is recreated on each build. Either mount type works; the entrypoint
   fixes ownership for bind mounts too.
5. **Environment variables: none are required.** The Dockerfile sets `NODE_ENV`,
   `PORT`, `HOSTNAME`, `DATA_DIR` and `NEXT_TELEMETRY_DISABLED`.
6. Deploy.

There are no API keys or tokens anywhere in this app — nothing calls an external
service.

### Redeploying after a push

Push to the branch Coolify is watching. If auto-deploy is on, Coolify rebuilds and
restarts automatically; otherwise press **Redeploy** in the Coolify UI.

The `/data` volume is not touched by a rebuild, so **your song projects survive
redeploys**. The container is replaced; the volume is not.

### Troubleshooting: "Bad Gateway"

If the domain returns a 502 while the container shows as running, the cause is almost
always the `HOSTNAME` collision.

Next's standalone server does `server.listen(port, process.env.HOSTNAME || '0.0.0.0')`,
and **Docker sets `HOSTNAME` in every container** to the container's own hostname. Next
then binds to that hostname instead of all interfaces — either failing outright with
`ENOTFOUND`, or binding to a single container IP that the proxy is not routing to. The
container looks perfectly healthy the whole time.

The `Dockerfile` pins `ENV HOSTNAME=0.0.0.0` and `scripts/start.mjs` overrides it at
runtime, so both paths are covered. But:

- **Never set a `HOSTNAME` environment variable** to anything else. To bind to one
  specific interface, use `BIND_HOST` instead.
- If you switch to a build pack that skips the Dockerfile, set `HOSTNAME=0.0.0.0`
  manually.

To confirm the diagnosis, check the container logs. Healthy startup logs
`- Network: http://0.0.0.0:3000`; the broken case logs `⨯ Failed to start server`.

Other things worth checking, in order:

| Symptom | Cause |
|---|---|
| `/api/health` returns 500 | `/data` is not writable, so the health check fails and the proxy drops the container |
| `{"ffmpeg":false}` in `/api/health` | The Dockerfile build pack is not in use — exports will ship the original audio |
| Build fails on `"/app/public": not found` | `public/` was deleted; it is tracked via `public/.gitkeep` for exactly this reason |

---

## How a project is stored

```
$DATA_DIR/
  songs.json            index: id, title, artist, album, year, timestamps
  songs/
    <song-id>/
      project.json      SOURCE OF TRUTH — all editable chart state
      audio.wav         your uploaded audio (extension preserved)
      album.png         cover art, if uploaded
      source.mid        the original reference file, kept for re-import
      notes.chart       GENERATED from project.json on every save
  tmp/                  upload staging and export scratch, swept automatically
```

`project.json` is the source of truth, not `notes.chart`. Round-tripping `.chart`
through an editor is lossy: note flags are stored as separate lines sharing a tick, and
notes carry no stable identity for selection and drag state. So the editor reads and
writes JSON, and `notes.chart` is regenerated on every save — it can never drift.

Nothing stops you editing `project.json` by hand; the app validates and normalises it
on the next save.

---

## Reading the highway

Note types are distinguished by SHAPE, not just colour, so a chart stays readable
while it scrolls — the same convention Moonscraper and the Guitar Hero games use:

| Shape | Meaning |
|---|---|
| Wide gem | Strum — must be picked |
| Narrow pill with a bright core | HOPO — hammer-on / pull-off, no pick needed |
| Thin bar | Tap note |
| Full-width purple bar | Open note |
| Cyan tint, over a shaded band | Inside a star power phrase |

HOPO status is **derived**, not stored: the `.chart` format only records the `forced`
flag, which inverts the natural result. A note is a natural HOPO when it falls within a
1/12 step of the previous note, on a different fret, and is not part of a chord. The
highway shows what each note will actually *do* in game rather than which flag is set,
so repeated notes on one fret correctly stay strums however close together they are.

## Editor controls

| Input | Action |
|---|---|
| Click a lane | Place a note at the nearest snap point |
| Click a note | Select it |
| Shift / Ctrl + click | Add to or remove from the selection |
| Shift + drag empty space | Marquee select |
| Drag a note | Move it, snapped to the grid |
| Drag a note's tail end | Extend it into a sustain |
| Right-click a note | Delete, toggle forced/tap, make open, clear sustain |
| `1`–`5` | Place a note in that lane at the playhead |
| `0` | Place an open note |
| `F` / `T` | Toggle forced / tap on the selection |
| `Delete` | Delete the selection |
| `Space` | Play / pause |
| `Home` | Jump to the start |
| Mouse wheel | Scrub the timeline (hold Shift to move faster) |
| `Ctrl`/`Cmd` + `Z` / `Shift+Z` | Undo / redo |
| `Ctrl`/`Cmd` + `S` | Save now |

Edits autosave 1.5 seconds after you stop, and the tab warns before closing with
unsaved changes.

### Song properties

The editor sidebar has two tabs. **Song** edits the title, artist, album, year, genre
and charter, and replaces the album art — with a live preview of the export folder name,
since three of those fields determine it. **Sync** holds the tempo map, time signatures
and chart offset. Property edits go through the same undo history and autosave as note
edits.

### Auto-detect BPM

Analyses the decoded audio in your browser and suggests a starting tempo. Treat it as
a starting point, not an answer — beat detection is frequently wrong on songs with
tempo changes or sparse percussion, and often reports half or double the real tempo.
Always confirm against the waveform before charting on top of it.

---

## MIDI import

The converter inspects the file before mapping it. On import you get a report showing
every track found, which one was charted from and why, and a **histogram of every MIDI
note number in that track**. That histogram is how you spot a file using an unusual
octave layout, instead of silently ending up with an empty chart.

The standard layout it expects:

| Difficulty | Green–Orange | Forced HOPO | Open |
|---|---|---|---|
| Expert | 96–100 | 101 | 103 |
| Hard | 84–88 | 89 | — |
| Medium | 72–76 | 77 | — |
| Easy | 60–64 | 65 | — |

Note 116 marks star power phrases and note 104 marks tap phrases; both are global
across difficulties. A uniform octave shift is detected and corrected automatically,
with a warning.

Tempo and time-signature maps are imported from the MIDI header, and ticks are rescaled
from the file's PPQ to the chart resolution of 192.

---

## Tech notes

- **Next.js 15** (App Router), React 19, Tailwind.
- **Chart resolution is 192 ticks per quarter note.** That is `2^6 × 3`, so both binary
  and triplet subdivisions land on whole ticks with no rounding drift — which is why
  it is the format's standard.
- **Tempo changes make tick↔time non-linear.** `TimingMap` precomputes a segment table
  and binary-searches it, because the renderer performs these conversions thousands of
  times per frame.
- **The audio element is the clock.** Playback position is never React state; the
  canvas render loop reads it from a ref and interpolates between authoritative
  readings using `performance.now()`, since `<audio>` updates `currentTime` well below
  60 Hz.
- **Uploads stream to disk** via busboy rather than `request.formData()`, which buffers
  entire files in memory.
