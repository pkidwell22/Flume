/**
 * Durable result-byte staging for frame authoring.
 *
 * Accepted provider bytes are persisted before a review reports success and are read back only for
 * the exact project/review/hash identity that produced them. Paths are derived only from validated
 * UUIDs and the content hash, so no caller-supplied path segment can escape the staging root. The
 * staging reference is a relative path that never leaves the server.
 *
 * This module owns the filesystem; it performs no media inspection, database work or network calls.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { MAX_FRAME_RESULT_BYTES, type FrameImageMime, type FrameResultStagingPort } from './frame-authoring.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const EXTENSIONS: Record<FrameImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export type FrameStagingErrorCode =
  | 'staging_root_invalid' | 'staging_path_invalid' | 'staging_mime_invalid'
  | 'staging_hash_mismatch' | 'staging_too_large' | 'staging_missing' | 'staging_integrity';

export class FrameStagingError extends Error {
  constructor(readonly code: FrameStagingErrorCode, message: string, readonly status = 409) {
    super(message);
    this.name = 'FrameStagingError';
  }
}

export interface FrameOutputStagingOptions {
  /** Absolute server-owned directory. Created on first use with owner-only permissions. */
  root: string;
  maxBytes?: number;
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function requireSegment(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new FrameStagingError('staging_path_invalid', `A literal ${field} is required for staged result bytes.`);
  }
  return value.toLowerCase();
}

function requireMime(value: unknown): FrameImageMime {
  if (typeof value !== 'string' || !(value in EXTENSIONS)) {
    throw new FrameStagingError('staging_mime_invalid', 'Staged results are limited to PNG, JPEG or WebP.');
  }
  return value as FrameImageMime;
}

export function createFrameOutputStaging(options: FrameOutputStagingOptions): FrameResultStagingPort & { root: string } {
  const root = options?.root;
  if (typeof root !== 'string' || !isAbsolute(root) || /[\u0000-\u001f\u007f]/.test(root)) {
    throw new TypeError('A staging root must be an absolute server-owned path without control characters.');
  }
  const maxBytes = options.maxBytes ?? MAX_FRAME_RESULT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FRAME_RESULT_BYTES) {
    throw new RangeError('staging maxBytes must be a positive integer within the frame result limit.');
  }

  function directory(projectId: string, reviewId: string): string {
    return join(root!, requireSegment(projectId, 'project id'), requireSegment(reviewId, 'review id'));
  }
  function filePath(input: { projectId: string; reviewId: string; mimeType: FrameImageMime; sha256: string }): { dir: string; file: string; relative: string } {
    const projectId = requireSegment(input.projectId, 'project id');
    const reviewId = requireSegment(input.reviewId, 'review id');
    const mimeType = requireMime(input.mimeType);
    if (typeof input.sha256 !== 'string' || !SHA256.test(input.sha256)) {
      throw new FrameStagingError('staging_hash_mismatch', 'A lowercase sha256 identity is required for staged result bytes.');
    }
    const dir = join(root!, projectId, reviewId);
    const name = `${input.sha256}.${EXTENSIONS[mimeType]}`;
    return { dir, file: join(dir, name), relative: `${projectId}/${reviewId}/${name}` };
  }

  return {
    root: root,

    async stage(input) {
      if (!(input?.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
        throw new FrameStagingError('staging_integrity', 'Accepted result bytes are required for staging.');
      }
      if (input.bytes.byteLength > maxBytes) throw new FrameStagingError('staging_too_large', 'The result exceeds the staging byte limit.');
      const target = filePath(input);
      if (digest(input.bytes) !== input.sha256) {
        throw new FrameStagingError('staging_hash_mismatch', 'The accepted result bytes do not match the recorded hash.');
      }
      await mkdir(target.dir, { recursive: true, mode: 0o700 });
      const temporary = `${target.file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(input.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target.file);
      return { ref: target.relative };
    },

    async read(input) {
      const target = filePath(input);
      if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > maxBytes) {
        throw new FrameStagingError('staging_integrity', 'The recorded staged result size is not acceptable.');
      }
      let size: number;
      try {
        size = (await stat(target.file)).size;
      } catch {
        throw new FrameStagingError('staging_missing', 'No staged result bytes exist for this review.');
      }
      if (size !== input.byteSize) throw new FrameStagingError('staging_integrity', 'The staged result size no longer matches its record.');
      const bytes = new Uint8Array(await readFile(target.file));
      if (bytes.byteLength !== input.byteSize || digest(bytes) !== input.sha256) {
        throw new FrameStagingError('staging_integrity', 'The staged result bytes no longer match their recorded hash.');
      }
      return bytes;
    },

    async discard(input) {
      await rm(directory(input.projectId, input.reviewId), { recursive: true, force: true });
    },
  };
}
