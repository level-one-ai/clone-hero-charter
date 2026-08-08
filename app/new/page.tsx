'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { MidiImportReport } from '@/lib/chart/midiToChart';
import { createSong } from '@/lib/client/api';

/**
 * New Song screen.
 *
 * On submit the server creates the project folder, stores the audio, and converts a
 * .mid (or ingests a .chart) into notes.chart. When a MIDI is imported we show the
 * import report BEFORE navigating to the editor — the note histogram is how a user
 * spots a file that uses a non-standard octave layout, and silently opening an empty
 * editor would hide exactly the problem they need to see.
 */
export default function NewSongPage() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    id: string;
    warnings: string[];
    midiReport: MidiImportReport | null;
  } | null>(null);

  const [audioName, setAudioName] = useState('');
  const [referenceName, setReferenceName] = useState('');
  const [albumArtName, setAlbumArtName] = useState('');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    const form = new FormData(event.currentTarget);

    const year = String(form.get('year') ?? '').trim();
    if (year && !/^\d{4}$/.test(year)) {
      setError('Release year must be exactly 4 digits.');
      return;
    }
    const audio = form.get('audio');
    if (!(audio instanceof File) || audio.size === 0) {
      setError('Select an audio file.');
      return;
    }

    // Empty optional file inputs still serialise as a zero-byte file; strip them so
    // the server does not treat them as a real upload.
    for (const key of ['reference', 'albumArt']) {
      const value = form.get(key);
      if (value instanceof File && value.size === 0) form.delete(key);
    }

    setSubmitting(true);
    setError(null);
    setProgress(0);

    try {
      const created = await createSong(form, setProgress);
      // Navigate straight through when there is nothing worth reading.
      if (created.warnings.length === 0 && !created.midiReport) {
        router.push(`/songs/${created.id}`);
        return;
      }
      setResult({
        id: created.id,
        warnings: created.warnings,
        midiReport: created.midiReport,
      });
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  if (result) {
    return <ImportSummary result={result} onContinue={() => router.push(`/songs/${result.id}`)} />;
  }

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-edge px-6 py-4">
        <h1 className="text-sm uppercase tracking-[0.3em] text-fg">New Song</h1>
        <Link href="/" className="ch-button">
          Cancel
        </Link>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <form ref={formRef} onSubmit={handleSubmit} className="mx-auto max-w-2xl">
          {error && (
            <div className="mb-4 border border-danger bg-panel px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          <section className="ch-panel rounded-md p-5">
            <h2 className="mb-4 text-2xs uppercase tracking-widest text-muted">Metadata</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Song Title" required>
                <input name="title" required maxLength={300} className="ch-input" autoFocus />
              </Field>
              <Field label="Artist" required>
                <input name="artist" required maxLength={300} className="ch-input" />
              </Field>
              <Field label="Album">
                <input name="album" maxLength={300} className="ch-input" />
              </Field>
              <Field label="Release Year">
                <input
                  name="year"
                  className="ch-input"
                  inputMode="numeric"
                  pattern="\d{4}"
                  maxLength={4}
                  placeholder="2024"
                />
              </Field>
              <Field label="Charter">
                <input name="charter" maxLength={120} className="ch-input" placeholder="Your name" />
              </Field>
            </div>
          </section>

          <section className="ch-panel mt-4 rounded-md p-5">
            <h2 className="mb-4 text-2xs uppercase tracking-widest text-muted">Files</h2>
            <div className="space-y-4">
              <FilePicker
                name="audio"
                label="Song Audio"
                required
                accept=".wav,.ogg,.mp3,.opus,.flac,audio/*"
                hint="WAV, OGG, MP3, OPUS or FLAC. Exported as OGG."
                filename={audioName}
                onChange={setAudioName}
              />
              <FilePicker
                name="reference"
                label="Reference Chart"
                accept=".mid,.midi,.chart"
                hint="Optional. A .mid is converted to a chart; a .chart is imported directly."
                filename={referenceName}
                onChange={setReferenceName}
              />
              <FilePicker
                name="albumArt"
                label="Album Art"
                accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                hint="Optional. PNG or JPG, square works best."
                filename={albumArtName}
                onChange={setAlbumArtName}
              />
            </div>
          </section>

          <div className="mt-5 flex items-center gap-4">
            <button type="submit" className="ch-button ch-button-primary" disabled={submitting}>
              {submitting ? 'Loading…' : 'Load'}
            </button>
            {submitting && (
              <div className="flex flex-1 items-center gap-3">
                <div className="h-1 flex-1 border border-edge2 bg-bg">
                  <div
                    className="h-full bg-fg transition-[width] duration-150"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <span className="font-mono text-2xs text-faint">
                  {progress >= 1 ? 'Processing…' : `${Math.round(progress * 100)}%`}
                </span>
              </div>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="ch-label">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      {children}
    </label>
  );
}

function FilePicker({
  name,
  label,
  accept,
  hint,
  required,
  filename,
  onChange,
}: {
  name: string;
  label: string;
  accept: string;
  hint: string;
  required?: boolean;
  filename: string;
  onChange: (name: string) => void;
}) {
  return (
    <div>
      <span className="ch-label">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      <div className="flex items-center gap-3">
        <label className="ch-button cursor-pointer">
          Choose File
          <input
            type="file"
            name={name}
            accept={accept}
            required={required}
            className="hidden"
            onChange={(event) => onChange(event.target.files?.[0]?.name ?? '')}
          />
        </label>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
          {filename || 'No file selected'}
        </span>
      </div>
      <p className="mt-1 text-2xs text-faint">{hint}</p>
    </div>
  );
}

/**
 * Import report. The histogram is the important part: it shows the actual note
 * numbers found in the reference file, so an unexpected layout is visible rather
 * than silently producing an empty chart.
 */
function ImportSummary({
  result,
  onContinue,
}: {
  result: { id: string; warnings: string[]; midiReport: MidiImportReport | null };
  onContinue: () => void;
}) {
  const report = result.midiReport;
  const histogram = report
    ? Object.entries(report.noteHistogram).sort((a, b) => Number(a[0]) - Number(b[0]))
    : [];
  const maxCount = histogram.reduce((max, [, count]) => Math.max(max, count), 0);

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <header className="flex items-center justify-between border-b border-edge px-6 py-4">
        <h1 className="text-sm uppercase tracking-[0.3em] text-fg">Import Report</h1>
        <button type="button" className="ch-button ch-button-primary" onClick={onContinue}>
          Open Editor
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {result.warnings.length > 0 && (
            <section className="border border-lane-orange bg-panel p-4">
              <h2 className="mb-2 text-2xs uppercase tracking-widest text-lane-orange">Warnings</h2>
              <ul className="space-y-1 text-xs text-fg">
                {result.warnings.map((warning) => (
                  <li key={warning}>— {warning}</li>
                ))}
              </ul>
            </section>
          )}

          {report && (
            <>
              <section className="ch-panel rounded-md p-4">
                <h2 className="mb-3 text-2xs uppercase tracking-widest text-muted">Source</h2>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                  <Row label="Charted from" value={report.selectedTrack} />
                  <Row label="Why" value={report.selectionReason} />
                  <Row label="PPQ → resolution" value={`${report.ppq} → ${report.resolution}`} />
                  <Row
                    label="Octave offset"
                    value={report.octaveOffset === 0 ? 'none (standard layout)' : `${report.octaveOffset > 0 ? '+' : ''}${report.octaveOffset} semitones`}
                  />
                  <Row label="Tempo markers" value={String(report.tempoCount)} />
                  <Row label="Time signatures" value={String(report.timeSignatureCount)} />
                </dl>
              </section>

              <section className="ch-panel rounded-md p-4">
                <h2 className="mb-3 text-2xs uppercase tracking-widest text-muted">
                  Notes imported
                </h2>
                <div className="grid grid-cols-4 gap-3">
                  {(['Expert', 'Hard', 'Medium', 'Easy'] as const).map((difficulty) => (
                    <div key={difficulty} className="border border-edge px-3 py-2">
                      <p className="text-2xs uppercase tracking-widest text-faint">{difficulty}</p>
                      <p className="mt-1 font-mono text-lg text-fg">
                        {report.notesPerDifficulty[difficulty]}
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="ch-panel rounded-md p-4">
                <h2 className="mb-1 text-2xs uppercase tracking-widest text-muted">
                  Note histogram
                </h2>
                <p className="mb-3 text-2xs text-faint">
                  Every MIDI note number found in the charted track. Expert frets are 96–100,
                  Hard 84–88, Medium 72–76, Easy 60–64.
                </p>
                <ul className="space-y-1">
                  {histogram.map(([note, count]) => (
                    <li key={note} className="flex items-center gap-3">
                      <span className="w-10 shrink-0 text-right font-mono text-2xs text-muted">
                        {note}
                      </span>
                      <span className="h-3 flex-1 bg-bg">
                        <span
                          className="block h-full bg-edge2"
                          style={{ width: `${maxCount > 0 ? (count / maxCount) * 100 : 0}%` }}
                        />
                      </span>
                      <span className="w-10 shrink-0 font-mono text-2xs text-faint">{count}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="ch-panel rounded-md p-4">
                <h2 className="mb-3 text-2xs uppercase tracking-widest text-muted">
                  Tracks in the file
                </h2>
                <ul className="space-y-1 font-mono text-2xs text-muted">
                  {report.trackSummaries.map((track) => (
                    <li key={track.index}>
                      [{track.index}] {track.name} — {track.noteCount} notes
                      {track.range ? `, notes ${track.range[0]}–${track.range[1]}` : ', no notes'}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="text-fg">{value}</dd>
    </>
  );
}
