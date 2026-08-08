import { NextResponse } from 'next/server';
import { ensureDataDirs } from '@/lib/server/paths';
import { hasFfmpeg } from '@/lib/server/audio';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Liveness probe for Docker/Coolify. Also reports whether ffmpeg is available. */
export async function GET() {
  try {
    await ensureDataDirs();
    return NextResponse.json({ ok: true, ffmpeg: await hasFfmpeg() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
