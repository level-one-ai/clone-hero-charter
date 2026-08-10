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

**Guitar Pro files.** As well as `.mid` and `.chart`, the reference-file slot accepts
`.gp3`, `.gp4`, `.gp5`, `.gpx` and `.gp` — useful because Guitar Pro's own MIDI export is
sometimes written corrupt, leaving the `.gp` file as the only usable source.

Parsing is done in-process by [alphaTab](https://alphatab.net), which is where the
well-known GuitarPro-to-Midi CLI's importers were ported from — same lineage, same
formats, but a plain npm dependency with no native code, so it needs no Docker changes and
works in development. alphaTab's *MIDI file writer* has known output bugs, so we never ask
for one: its generator runs into an in-memory event list that we read directly.

Two things come free from going through the score model rather than a MIDI file: the track
picker shows real names ("Rhythm and Lead Guitar") instead of "track 4", and the song
title, artist and album are read from the file to prefill the form.

A Guitar Pro score is sheet music, never the Guitar Hero note layout, so these files are
always imported in musical mode — the pitches are mapped to frets by contour. The track is
still chosen by name where possible, so a file with "Guitar 1" and "Drums" charts the
guitar even though the drums have more notes.

**Audio format.** Exports transcode to OGG Vorbis by default — the community standard,
and roughly ten times smaller than a lossless WAV. Clone Hero also loads `.wav`, `.mp3`
and `.opus`, so the export dialog has a **Keep the original audio** toggle when you'd
rather ship `song.wav` untouched. If ffmpeg is unavailable or cannot read your file,
the export falls back to the original audio and tells you it did — before the download
starts, not after: opening the export dialog asks the server what the archive would
contain (`GET /api/songs/<id>/export?dryRun=1`) and shows the real file list and warnings.

The download itself is a plain navigation to `GET /api/songs/<id>/export`, so the browser
streams the zip straight to disk instead of the tab buffering the whole archive in memory.

**Serve the app over HTTPS.** Chrome blocks `.zip` downloads from insecure (HTTP)
origins with *"Insecure download blocked"*, offering only *Discard* — there is no "keep
anyway" for this class of block. That is correct behaviour: over plain HTTP the archive
can be rewritten in transit. So the fix is a certificate, not a workaround.

On Coolify, point a domain's A record at the server, set the application's domain to
`https://…`, enable **Generate SSL Certificate**, and redeploy. Ports **80 and 443** both
have to be reachable — 80 is where Let's Encrypt answers its HTTP-01 challenge — and on
Oracle Cloud images that means the host firewall as well as the VCN security list. If the
DNS is behind Cloudflare, set the record to DNS-only while the certificate issues, since
the proxy intercepts the challenge path.

Prefer a domain you control over a `*.sslip.io` address. Let's Encrypt rate-limits per
registered domain, and `sslip.io` is a single registered domain shared by everyone using
the service — its weekly quota has been exhausted before
([cunnie/sslip.io#108](https://github.com/cunnie/sslip.io/issues/108)), which fails
issuance through no fault of your configuration.

**Downloading files individually.** The export dialog lists each file in the folder with
its own download link, served by `GET /api/songs/<id>/export/file?name=<file>`. They come
from the same plan as the zip, so a file fetched on its own is the one that would have
been inside the archive — the chart carries the same lead-in offset, and the audio is the
same transcode. Two reasons this exists:

- A Clone Hero song *is* a folder of these files; the zip is only a wrapper. Pulling a
  tweaked `notes.chart` on its own beats re-downloading forty megabytes of audio with it.
- Chrome's insecure-download block targets archives and executables, not text and audio.
  On a plain-HTTP deployment the dialog says so and points at these links, so an instance
  without a certificate is never a dead end. Fixing HTTPS is still the right answer, and
  Firefox does not block the zip in the first place.

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
| `Ctrl`/`Cmd` + `A` | Select everything in this difficulty |
| Shift + click a note | Select everything between it and the last note you clicked |
| `Ctrl`/`Cmd` + click | Add or remove a single note |
| `Ctrl`/`Cmd` + `C` / `X` / `V` | Copy / cut / paste a block |
| `Alt` + `←` / `→` | Move the selection down or up a fret |
| `P` | Arm the star power tool, then click the phrase's start and end |
| `Ctrl`/`Cmd` + `Z` / `Shift+Z` | Undo / redo |
| `Ctrl`/`Cmd` + `S` | Save now |

Every one of these is also a button on the note bar above the highway, and the full list
is behind the **?** in the transport bar.

Edits autosave 1.5 seconds after you stop, and the tab warns before closing with
unsaved changes.

### Selecting a passage, and copy/paste

Click a note to select it — that also anchors a range. **Shift-click** a second note and
everything between the two is selected, across all five lanes plus open notes, because a
range is a slice of the song rather than of one lane. `Ctrl`/`Cmd` + click adds or removes
a single note. Shift + drag on empty space is still the marquee.

`Ctrl+C` copies the selection, `Ctrl+X` cuts it, `Ctrl+V` pastes at the playhead **in
whichever difficulty is open**. A block keeps its lanes, sustains, chord shapes and
tap/forced flags, and is stored relative to its own first note, so it lands intact
wherever you put it. Pasting over existing notes replaces them.

Copying into a different difficulty is the point rather than an accident: copy the Expert
chorus, switch to Hard, paste, thin it out.

Star power, sections and tempo are deliberately not part of a copied block. They belong to
the song rather than to a run of notes, and pasting should never quietly change phrasing
somewhere you are not looking.

### Generating lower difficulties

Chart Expert, then open Hard, Medium or Easy and press **Generate from Expert**. Chords
are opened up, notes that fall too close together are dropped, and the lane count narrows
as the difficulty drops (five frets on Hard, four on Medium, three on Easy).

Reduction only ever *removes*: every generated note exists in Expert at the same tick, on
a lane Expert used or folded inward from it. Nothing is invented, so a generated
difficulty can never drift out of time with the song. Notes on strong beats survive in
preference to off-beat ones, and a reduced chord keeps its lowest lane so the line stays
melodically coherent.

It replaces the difficulty, so it asks first, and it is a single undo away. Treat the
result as a starting point to review rather than a finished chart.

### The chart check

The **Check** tab lists what would break the song in game while still loading fine — the
mistakes Clone Hero says nothing about:

- notes past the end of the audio
- an open note sharing a tick with fret notes (invalid)
- two notes stacked on one fret at one moment
- sustains too short to register
- a sustain running into the next note on the same fret
- a star power phrase containing no notes, which can never be activated
- no BPM marker at the start, or an empty Expert chart

Click an issue to jump the playhead to it. A summary also appears in the export dialog.
None of it blocks an export — it is your chart, and the tool's job is to tell you, not to
argue.

### Sections and star power

The **Chart** tab holds both. A section is added at the playhead with a name (or one of
the presets), and appears on the highway as a gold line with its name in the gutter.
Sections are written to the chart as `section <name>` events, which is what Clone Hero
reads for its practice-mode list — they are what makes a long chart navigable.

Star power phrases are per difficulty and drawn point to point, because in game a phrase
is a region of the song rather than a set of notes. Press **Star power** on the note bar
(or `P`) to arm the tool, click where the phrase starts on the highway, then click where
it ends; a dashed band follows the cursor in between so you can see what you are about to
create. The tool disarms itself after the second click, so it cannot quietly keep placing
phrases, and `Esc` cancels mid-placement.

Clicking backwards — end first — works and is normalised. Two clicks landing on the same
snap point create nothing, since a zero-length phrase does not register in game. Drawing
across an existing phrase merges the two, which is what Clone Hero requires, as it does
not accept overlapping phrases.

### Lead-in silence

Under **Sync**. Adds real silence to the front of the exported audio so the song starts a
little later, giving you room to get your bearings before the first note.

Nothing moves on the highway. The silence is added to the audio with ffmpeg at export
time, and the chart's `Offset` is increased to match, so the two stay in step
automatically and `song_length` accounts for it. midi-ch has the same setting but leaves
padding the audio to you in a DAW.

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

### Picking the guitar track

Chart MIDIs are supposed to name the lead part `PART GUITAR`, but plenty do not — some
name it something else, some leave tracks unnamed entirely. So the importer tries, in
order:

1. an exact standard name (`PART GUITAR`, `T1 GEMS`, …)
2. any name containing "guitar", excluding Pro Guitar / GHL / bass / co-op parts
3. **the track whose notes best fit the chart layout**, ignoring names entirely

Step 3 is the one that rescues unnamed files. It scores each track on the fraction of
its notes that land on valid chart note numbers — a real chart part scores ~100%, while
ordinary music scores around 60% at best, since it scatters across the chromatic scale.
Ties are broken by how many difficulties a track covers, because a finished guitar part
spans several while a stray track usually occupies one.

**When it still guesses wrong.** `PART DRUMS` uses the *same* note numbers as
`PART GUITAR`, so in an unnamed file no heuristic can reliably tell them apart. If the
wrong part was imported, or a difficulty came in empty, open the editor and use
**Song → Re-import from MIDI**. It lists every track with its note counts and fit score
and lets you pick by hand, or set an octave offset. Your audio, artwork and metadata are
kept; only the notes and tempo map are replaced.

### Transcriptions (ordinary song MIDIs)

If no track scores as a chart, the file is a **transcription** — a MIDI of the actual
music, where note 40 means E2 rather than "green". Plenty of guitar MIDIs found online
are like this.

These are still worth importing, because the hard part of charting is the timing, and a
transcription already has it exactly. The importer keeps the note timings, tempo map and
time signatures verbatim, and derives the frets from the pitches.

**By pitch (the default).** Low pitches take green, high pitches take orange. Every note of a chord is
mapped by its own pitch, so a chord's shape on the fretboard mirrors its shape in the
music. The mapping is monotonic: a higher pitch never lands on a lower fret.

The lowest band becomes **open notes** (the purple bar) by default, giving six bands
rather than five. Where a chord straddles that boundary the frets win, since Clone Hero
cannot play an open note together with frets.

How the band boundaries are drawn matters more than it sounds, because most parts are
not evenly spread across their range:

| Split | Behaviour |
|---|---|
| **Local** (default) | Ranks each pitch against only the notes played around it |
| **Balanced** | One mapping for the whole song, with boundaries placed so each fret gets a similar share of the notes |
| **By pitch count** | Equal numbers of distinct pitches per fret |
| **Even split** | Equal slices of the pitch range — most literal |

The first three are progressively less literal and progressively more playable. An even
split is the most faithful and often the worst to play: on a riff camped on a few low
notes it can put over half the song on green and leave blue almost unused.

**Local** is the approach [efhiii/midi-ch](https://github.com/EFHIII/midi-ch) takes, and
it is the default here for the same reason. A single global mapping lets whichever
section is busiest decide the boundaries for the entire song, so a quieter passage
sitting a few semitones above it collapses onto one or two frets. Ranking within a
rolling window means the frets describe "high or low *for this part of the song*", and
every phrase spreads across the whole fretboard. On a real transcription this took
orange from 4% of notes to 15%. The trade is that a given pitch can take different frets
in different sections; the other splits keep it fixed.

**By melody** is the alternative, chosen in the same dialog: the fret moves as the
melody moves, up for a rise and down for a fall, further for a bigger interval. It
spreads across the fretboard more evenly, at the cost of the same pitch landing on
different frets in different places.

Whichever is used, sustains take a quarter-note threshold rather than the 1/12 step used
for real charts. Transcriptions are written legato, so the shorter threshold turns ~80%
of the chart into sustains.

Lower difficulties are deliberately left empty. Auto-thinned ones come out unmusical and
need redoing anyway.

All of this is adjustable under **Song → Re-import from MIDI**: the **Auto / Chart /
Melody** switch forces how the file is read, and when it is read as a melody you get the
mapping strategy, band split, open-note toggle, an **Invert** option (high pitches on
green instead of orange), and a maximum chord size.

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
