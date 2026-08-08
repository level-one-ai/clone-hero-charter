import { NextResponse } from 'next/server';
import { isValidSongId } from '@/lib/server/paths';
import { readProject, saveProject } from '@/lib/server/storage';
import { normalizeProject, projectSchema } from '@/lib/server/validation';

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

  const project = normalizeProject(parsed.data);
  project.id = id;
  // Audio identity and duration are server-measured facts, not client opinions.
  project.audio = existing.audio;
  project.album = existing.album;

  try {
    await saveProject(project);
  } catch (error) {
    console.error(`Failed to save chart for ${id}:`, error);
    return NextResponse.json({ error: 'Could not write the chart to disk' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, project });
}
