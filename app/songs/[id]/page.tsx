import { notFound } from 'next/navigation';
import EditorShell from '@/components/EditorShell';
import { isValidSongId } from '@/lib/server/paths';
import { readProject } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Editor route. A server component reads project.json straight off disk and hands it
 * to the client shell, so the editor renders with its chart already present rather
 * than flashing empty while a fetch resolves.
 */
export default async function SongEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidSongId(id)) notFound();

  const project = await readProject(id);
  if (!project) notFound();

  return <EditorShell initialProject={project} />;
}
