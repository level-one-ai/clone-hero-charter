import { NextResponse } from 'next/server';
import { isValidSongId } from '@/lib/server/paths';
import { readProject, saveProject } from '@/lib/server/storage';
import { normalizeProject, projectSchema } from '@/lib/server/validation';
import { resolveRegion } from '@/lib/chart/audioTimeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * PUT /api/songs/[id]/chart — save chart edits.
 *
 * The editor autosaves the whole project, so this is the hot write path. It
 * validates, normalises (sorts, dedupes, guarantees tick-0 sync markers), then
 * persists project.json and regenerates notes.chart in one step.
 *
 * Fields the client must not be able to change — the id, and the audio metadata we
 * measured from the actual file on upload — are taken from the stored project rather
 * than the request body.
 */
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const existing = await readProject(id);
  if (!existing) return NextResponse.json({ error: 'Song not found' }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body was not valid JSON' }, { status: 400 });
  }

  const parsed = projectSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: `Invalid chart data at ${first.path.join('.') || '(root)'}: ${first.message}`,
        issues: parsed.error.issues.slice(0, 20),
      },
      { status: 400 },
    );
  }

  /**
   * LOST-UPDATE CHECK.
   *
   * The editor autosaves the whole project, so two people on the same song — or one
   * person with it open on a laptop and a desktop — would otherwise overwrite each
   * other, and whoever saved last would win silently. The client sends the revision it
   * loaded; if the stored one has moved past it, this save was built on a stale copy and
   * is refused so the UI can say so.
   *
   * A missing revision means an older client or a project saved before revisions
   * existed; those still save, because refusing them would break the app for anyone who
   * had not reloaded.
   */
  const clientRevision = parsed.data.revision;
  const storedRevision = existing.revision ?? 0;
  if (clientRevision !== undefined && clientRevision < storedRevision) {
    return NextResponse.json(
      {
        error:
          'This song was changed somewhere else since you opened it. Saving now would overwrite those changes.',
        conflict: true,
        storedRevision,
        yourRevision: clientRevision,
      },
      { status: 409 },
    );
  }

  const project = normalizeProject(parsed.data);
  project.id = id;
  project.revision = storedRevision;
  /**
   * The audio block holds two different kinds of thing, and they are treated differently.
   *
   * The filename, duration and sample rate are SERVER-MEASURED FACTS about a file on
   * disk; a client cannot know better and must not be able to overwrite them. The region
   * and the detection result are CHARTER DECISIONS made in the editor, and taking those
   * from the stored copy would mean they could never be saved at all.
   *
   * They live together because they describe the same file. Keeping the split explicit
   * here is what lets both be true.
   */
  const merged = {
    ...existing.audio,
    region: project.audio.region ?? null,
    detected: project.audio.detected ?? null,
  };
  /**
   * Re-clamp against the SERVER's duration, not the one the request carried.
   * normalizeProject already bounded the region, but it did so using the client's
   * `durationMs` — which we have just discarded in favour of the measured value. A
   * request claiming a longer file could otherwise store a region running past the end of
   * the real one.
   */
  const bounded = resolveRegion(merged);
  project.audio = {
    ...merged,
    region:
      bounded.startMs <= 0 && bounded.endMs >= (merged.durationMs || 0) ? null : bounded,
  };
  project.album = existing.album;

  let stored;
  try {
    stored = await saveProject(project);
  } catch (error) {
    console.error(`Failed to save chart for ${id}:`, error);
    return NextResponse.json({ error: 'Could not write the chart to disk' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, project: stored });
}
