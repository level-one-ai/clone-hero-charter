import { NextResponse } from 'next/server';
import { isValidSongId } from '@/lib/server/paths';
import { deleteProject, readProject } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ id: string }>;
}

/** GET /api/songs/[id] — the full project model. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const project = await readProject(id);
  if (!project) return NextResponse.json({ error: 'Song not found' }, { status: 404 });
  return NextResponse.json(project);
}

/** DELETE /api/songs/[id] — remove the folder and its index entry. */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidSongId(id)) return NextResponse.json({ error: 'Invalid song id' }, { status: 400 });

  const project = await readProject(id);
  if (!project) return NextResponse.json({ error: 'Song not found' }, { status: 404 });

  await deleteProject(id);
  return NextResponse.json({ ok: true });
}
