import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

/**
 * Audio duration and transcoding.
 *
 * song.ini's `song_length` must be accurate in milliseconds or Clone Hero's progress
 * bar and end-of-song detection are wrong, so this is worth getting right rather than
 * estimating from file size.
 */

export interface AudioProbe {
  durationMs: number;
  sampleRate: number | null;
}

/**
 * Read duration straight from the WAV header — no subprocess needed.
 *
 * RIFF layout: "RIFF" <size> "WAVE" then a sequence of chunks, each an 8-byte header
 * (4-char id + uint32 little-endian size) followed by its payload. We need `fmt ` for
 * the byte rate and `data` for the payload size; duration = dataBytes / byteRate.
 *
 * Chunks can appear in any order and some encoders insert LIST/fact chunks between
 * them, so we walk the chunk list rather than assuming fixed offsets. Odd-sized
 * chunks are padded to even boundaries, which is a classic source of parser drift.
 */
export async function probeWavHeader(filePath: string): Promise<AudioProbe | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    // 64 KiB is far more than enough to reach the data chunk header in any sane file.
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 44) return null;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      return null;
    }

    let offset = 12;
    let byteRate = 0;
    let sampleRate: number | null = null;

    while (offset + 8 <= bytesRead) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const body = offset + 8;

      if (chunkId === 'fmt ' && body + 16 <= bytesRead) {
        sampleRate = buffer.readUInt32LE(body + 4);
        byteRate = buffer.readUInt32LE(body + 8);
      } else if (chunkId === 'data') {
        if (byteRate <= 0) return null;
        // A streamed WAV can declare size 0xFFFFFFFF; fall back to the real file size.
        let dataBytes = chunkSize;
        if (dataBytes === 0 || dataBytes === 0xffffffff) {
          const stat = await handle.stat();
          dataBytes = Math.max(0, stat.size - body);
        }
        return { durationMs: (dataBytes / byteRate) * 1000, sampleRate };
      }

      // Chunks are word-aligned: an odd size is followed by one pad byte.
      offset = body + chunkSize + (chunkSize % 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Run ffprobe and read the container duration. Used for MP3/OGG and odd WAVs. */
export async function probeWithFfprobe(filePath: string): Promise<AudioProbe | null> {
  try {
    const out = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=sample_rate',
      '-of',
      'default=noprint_wrappers=1:nokey=0',
      filePath,
    ]);
    const durationMatch = /duration=([0-9.]+)/.exec(out);
    const sampleRateMatch = /sample_rate=([0-9]+)/.exec(out);
    if (!durationMatch) return null;
    const seconds = Number.parseFloat(durationMatch[1]);
    if (!Number.isFinite(seconds)) return null;
    return {
      durationMs: seconds * 1000,
      sampleRate: sampleRateMatch ? Number.parseInt(sampleRateMatch[1], 10) : null,
    };
  } catch {
    return null;
  }
}

/** WAV header fast path first, ffprobe as the general fallback. */
export async function probeAudio(filePath: string): Promise<AudioProbe> {
  if (/\.wav$/i.test(filePath)) {
    const header = await probeWavHeader(filePath);
    if (header && header.durationMs > 0) return header;
  }
  const probed = await probeWithFfprobe(filePath);
  return probed ?? { durationMs: 0, sampleRate: null };
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pre-flight the transcode: can this ffmpeg actually decode this file AND encode
 * Vorbis?
 *
 * This exists because of how a mid-stream failure plays out. The export streams the
 * zip, so response headers (including the 200) are already sent by the time ffmpeg
 * reports a problem. Aborting then hands the user a truncated, corrupt zip with a
 * success status and no error message — the worst possible outcome.
 *
 * So we decode a fraction of a second up front and discard it. If that fails, the
 * caller falls back to packaging the original audio with a visible warning. It costs
 * one cheap subprocess and turns a silent corrupt download into a working export.
 *
 * `hasFfmpeg` alone is not enough: a stripped ffmpeg build can exist on PATH and
 * still lack the WAV demuxer or the libvorbis encoder.
 */
export async function canTranscodeToOgg(inputPath: string): Promise<boolean> {
  try {
    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vn',
      '-t',
      '0.1',
      '-c:a',
      'libvorbis',
      '-f',
      'ogg',
      '-y',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn ffmpeg to transcode to OGG Vorbis and return the child process so the caller
 * can pipe stdout straight into the zip archive.
 *
 * Piping rather than writing a temp file matters: a 200 MB WAV would otherwise be
 * written to disk a second time on every export, and this app's disk is a mounted
 * volume the user cares about.
 *
 * -q:a 5 is ~160kbps VBR, the quality level the Clone Hero community uses for customs.
 */
export function spawnOggTranscode(inputPath: string, leadingSilenceMs = 0) {
  return spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...transcodeArgs(inputPath, leadingSilenceMs)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * ffmpeg arguments for the export transcode, optionally prepending silence.
 *
 * `adelay` shifts the audio later within the same stream rather than concatenating a
 * separate silent file, which avoids any sample-rate or channel-layout mismatch
 * between the two. `all=1` applies the delay to every channel — without it only the
 * first channel is delayed and the result is audibly out of phase.
 */
function transcodeArgs(inputPath: string, leadingSilenceMs: number): string[] {
  const args = ['-i', inputPath, '-vn']; // -vn drops embedded art, which would break the ogg
  if (leadingSilenceMs > 0) {
    args.push('-af', `adelay=${Math.round(leadingSilenceMs)}:all=1`);
  }
  args.push('-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg', 'pipe:1');
  return args;
}

/**
 * Prepend silence to an audio file without transcoding to OGG, for the
 * keep-original-audio export path. Returns the child process so the caller can pipe
 * stdout into the archive.
 */
export function spawnSilencePad(inputPath: string, leadingSilenceMs: number, format: string) {
  return spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-vn',
      '-af',
      `adelay=${Math.round(leadingSilenceMs)}:all=1`,
      '-f',
      format,
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}
