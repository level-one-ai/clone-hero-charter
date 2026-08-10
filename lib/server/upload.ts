import Busboy from 'busboy';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TMP_DIR, ensureDataDirs } from './paths';

/**
 * Streaming multipart parser.
 *
 * We deliberately do NOT use `request.formData()`. It buffers every uploaded file
 * fully in memory before handing it over, and the whole point of this app is
 * uploading tens of megabytes of WAV audio — a couple of concurrent uploads would
 * push the container into an OOM kill. Busboy streams each part straight to a temp
 * file on disk, so peak memory stays flat regardless of file size.
 *
 * Files land in <DATA_DIR>/tmp and the caller renames them into the project folder
 * once it has decided the upload is valid. Anything left behind on an error path is
 * cleaned up by `cleanupUpload`, and stale leftovers are swept on boot.
 */

export interface UploadedFile {
  /** Form field name, e.g. "audio". */
  field: string;
  /** Original filename as sent by the browser. */
  filename: string;
  mimeType: string;
  /** Absolute path to the staged temp file. */
  tempPath: string;
  size: number;
  /** True if the file was cut off by the size limit. */
  truncated: boolean;
}

export interface ParsedUpload {
  fields: Record<string, string>;
  files: UploadedFile[];
}

export interface UploadLimits {
  /** Per-file cap in bytes. Default 512 MB — a long lossless WAV is plausible. */
  maxFileSize?: number;
  maxFiles?: number;
}

export async function parseMultipart(
  request: Request,
  limits: UploadLimits = {},
): Promise<ParsedUpload> {
  await ensureDataDirs();

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new UploadError('Expected a multipart/form-data request', 415);
  }
  if (!request.body) {
    throw new UploadError('Request had no body', 400);
  }

  const maxFileSize = limits.maxFileSize ?? 512 * 1024 * 1024;
  const maxFiles = limits.maxFiles ?? 8;

  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];

  await new Promise<void>((resolve, reject) => {
    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: maxFileSize, files: maxFiles, fields: 40, fieldSize: 64 * 1024 },
    });

    // Track in-flight disk writes; busboy's 'close' can fire before they finish.
    const pending: Promise<void>[] = [];
    let failed = false;

    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      reject(error);
    };

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (field, stream, info) => {
      const tempPath = path.join(
        TMP_DIR,
        `upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      );
      const record: UploadedFile = {
        field,
        filename: info.filename ?? '',
        mimeType: info.mimeType ?? 'application/octet-stream',
        tempPath,
        size: 0,
        truncated: false,
      };
      files.push(record);

      stream.on('data', (chunk: Buffer) => {
        record.size += chunk.length;
      });
      // Emitted when busboy hits the fileSize limit; the stream is cut short here.
      stream.on('limit', () => {
        record.truncated = true;
      });

      pending.push(
        pipeline(stream, fs.createWriteStream(tempPath)).catch((error: Error) => {
          fail(error);
        }),
      );
    });

    busboy.on('error', (error) => fail(error as Error));
    busboy.on('close', () => {
      Promise.all(pending).then(() => {
        if (!failed) resolve();
      }, fail);
    });

    // Web ReadableStream -> Node Readable, so busboy can consume it.
    Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0])
      .on('error', fail)
      .pipe(busboy);
  }).catch(async (error) => {
    await cleanupUpload({ fields, files });
    throw error instanceof UploadError ? error : new UploadError(String(error), 400);
  });

  const truncated = files.find((f) => f.truncated);
  if (truncated) {
    await cleanupUpload({ fields, files });
    throw new UploadError(
      `"${truncated.filename}" exceeds the ${Math.round(maxFileSize / (1024 * 1024))} MB upload limit`,
      413,
    );
  }

  return { fields, files };
}

/** Delete every staged temp file. Safe to call twice. */
export async function cleanupUpload(upload: ParsedUpload): Promise<void> {
  await Promise.all(
    upload.files.map((file) => fsp.rm(file.tempPath, { force: true }).catch(() => {})),
  );
}

/**
 * Move a staged file into its final home.
 *
 * rename() fails with EXDEV across filesystems, which happens when /data is a mounted
 * volume and the temp dir is not — so fall back to a copy. In our own layout tmp/ is
 * inside DATA_DIR precisely so the fast path is taken, but the fallback keeps this
 * correct if someone points DATA_DIR elsewhere.
 */
export async function commitUploadedFile(tempPath: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(tempPath, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await fsp.copyFile(tempPath, target);
    await fsp.rm(tempPath, { force: true });
  }
}

export class UploadError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

/** Lowercase extension including the dot, or '' when there is none. */
export function extensionOf(filename: string): string {
  const ext = path.extname(filename || '').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export const AUDIO_EXTENSIONS = ['.wav', '.ogg', '.mp3', '.opus', '.flac'];
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
/**
 * Reference files an import can be built from.
 *
 * The Guitar Pro extensions are here because GP exports of MIDI are sometimes written
 * corrupt, and the .gp file itself is then the only usable source — see
 * lib/server/guitarPro.ts.
 */
export const CHART_EXTENSIONS = [
  '.mid',
  '.midi',
  '.chart',
  '.gp3',
  '.gp4',
  '.gp5',
  '.gpx',
  '.gp',
];
