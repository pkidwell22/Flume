import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, mkdir, open, readdir, link, unlink, mkdtemp, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { check, DEFAULT_LIMITS, hashId, uuid, MediaError } from './types.ts';
import type { StoreOptions, Limits, StoredRecord } from './types.ts';
import { uuidKey } from './identity.ts';

export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function recordIdentity(record: StoredRecord): string {
  // Only known UUID identity fields are comparable by case. Inspection, opaque provider
  // provenance and literal frozen selections/hashes remain byte-for-byte significant.
  const id = uuidKey(record.asset.id), projectId = uuidKey(record.asset.projectId);
  // Only our own derived media route follows the asset UUID's spelling; arbitrary URLs do not.
  const mediaUrl = record.asset.mediaUrl === `/api/media/${record.asset.id}` ? `/api/media/${id}` : record.asset.mediaUrl;
  return JSON.stringify({ ...record, asset: { ...record.asset, id, projectId, mediaUrl } });
}
export async function noLinks(path: string): Promise<void> {
  check(isAbsolute(path) && resolve(path) === path && !path.includes('\0'), 'INVALID_PATH');
  let part: string = sep;
  for (const name of path.split(sep).filter(Boolean)) {
    part = join(part, name); const s = await lstat(part);
    check(!s.isSymbolicLink(), 'SYMLINK_REJECTED');
  }
}
export async function regular(path: string, maxBytes: number): Promise<FileHandle> {
  await noLinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await file.stat(); check(s.isFile(), 'REGULAR_FILE_REQUIRED');
    check(s.size > 0 && s.size <= maxBytes, 'BYTE_LIMIT');
    return file;
  } catch (e) { await file.close(); throw e; }
}
export async function hashFile(file: FileHandle, maxBytes: number): Promise<{ sha256: string; size: number }> {
  const before = await file.stat(); const hash = createHash('sha256'); let size = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
    if (!bytesRead) break;
    size += bytesRead; check(size <= maxBytes, 'BYTE_LIMIT'); hash.update(buffer.subarray(0, bytesRead));
  }
  const after = await file.stat();
  check(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && size === after.size, 'SOURCE_CHANGED');
  return { sha256: hash.digest('hex'), size };
}
export interface Storage {
  root: string; limits: Limits; ffmpeg: string; ffprobe: string; importRoots: readonly string[];
  stage<T>(fn: (dir: string) => Promise<T>): Promise<T>;
  record(id: string): Promise<StoredRecord>;
  publish(path: string, record: StoredRecord): Promise<StoredRecord>;
  object(hash: string): string;
  verify(): Promise<void>;
}
export async function storage(options: StoreOptions): Promise<Storage> {
  const root = options.root;
  check(isAbsolute(root) && resolve(root) === root && root !== sep, 'INVALID_ROOT');
  await noLinks(dirname(root));
  try { await mkdir(root, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  await noLinks(root);
  const rootStat = await lstat(root);
  check(rootStat.isDirectory() && (rootStat.mode & 0o077) === 0 && rootStat.uid === process.getuid?.(), 'ROOT_NOT_PRIVATE');
  const marker = join(root, '.flume-media-owner');
  let token: string;
  try {
    const f = await regular(marker, 128); try { token = await f.readFile('utf8'); } finally { await f.close(); }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    check((await readdir(root)).length === 0, 'UNOWNED_ROOT');
    token = `flume-media-v1:${randomUUID()}`;
    const f = await open(marker, 'wx', 0o400); try { await f.writeFile(token); await f.sync(); } finally { await f.close(); }
  }
  check(/^flume-media-v1:[0-9a-f-]{36}$/.test(token), 'OWNER_MISMATCH');
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [k, v] of Object.entries(limits)) check(Number.isSafeInteger(v) && v > 0 && v <= DEFAULT_LIMITS[k as keyof Limits], 'INVALID_LIMIT');
  const importRoots = [...(options.importRoots ?? [])];
  for (const path of importRoots) { await noLinks(path); check((await lstat(path)).isDirectory(), 'INVALID_IMPORT_ROOT'); }
  const executables = await Promise.all([options.ffmpegPath, options.ffprobePath].map(async path => {
    check(isAbsolute(path), 'INVALID_EXECUTABLE'); const p = await realpath(path);
    const s = await lstat(p); check(s.isFile() && (s.mode & 0o111) !== 0, 'INVALID_EXECUTABLE'); return p;
  }));
  for (const name of ['objects', 'records', 'staging']) {
    const p = join(root, name); try { await mkdir(p, { mode: 0o700 }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    await noLinks(p); const s = await lstat(p); check(s.isDirectory() && (s.mode & 0o077) === 0, 'ROOT_NOT_PRIVATE');
  }
  let busy = false;
  const verify = async () => {
    await noLinks(root); const s = await lstat(root);
    check(s.ino === rootStat.ino && s.dev === rootStat.dev && (s.mode & 0o077) === 0, 'OWNER_MISMATCH');
    const f = await regular(marker, 128);
    try { check(await f.readFile('utf8') === token, 'OWNER_MISMATCH'); } finally { await f.close(); }
    for (const name of ['objects', 'records', 'staging']) {
      const p = join(root, name); await noLinks(p); const d = await lstat(p);
      check(d.isDirectory() && (d.mode & 0o077) === 0, 'ROOT_NOT_PRIVATE');
    }
  };
  const object = (hash: string) => { hashId(hash); return join(root, 'objects', hash); };
  const record = async (id: string): Promise<StoredRecord> => {
    uuid(id); await verify(); const file = await regular(join(root, 'records', `${id.toLowerCase()}.json`), limits.maxProcessOutputBytes);
    try {
      const r = JSON.parse(await file.readFile('utf8')) as StoredRecord;
      check(r.asset.id.toLowerCase() === id.toLowerCase(), 'RECORD_MISMATCH'); hashId(r.asset.sha256);
      check(r.asset.sha256 === r.inspection.sourceSha256, 'RECORD_MISMATCH'); return r;
    } finally { await file.close(); }
  };
  const publish = async (path: string, record: StoredRecord) => {
    const identity = recordIdentity(record); let stored = record;
    await verify(); const hash = record.asset.sha256; const dest = object(hash);
    const f = await regular(path, limits.maxBytes);
    try { check((await hashFile(f, limits.maxBytes)).sha256 === hash, 'SOURCE_CHANGED'); await f.chmod(0o400); await f.sync(); } finally { await f.close(); }
    try { await link(path, dest); } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const f = await regular(dest, limits.maxBytes);
      try { check((await hashFile(f, limits.maxBytes)).sha256 === hash, 'STORAGE_CORRUPT'); } finally { await f.close(); }
    }
    const json = JSON.stringify(record); const temp = join(dirname(path), 'record.json');
    const metadata = await open(temp, 'wx', 0o400);
    try { await metadata.writeFile(json); await metadata.sync(); } finally { await metadata.close(); }
    const target = join(root, 'records', `${record.asset.id.toLowerCase()}.json`);
    const syncDirectory = async (name: string) => {
      const d = await open(join(root, name), 'r'); try { await d.sync(); } finally { await d.close(); }
    };
    // Bytes are durable before the reference becomes visible.
    await syncDirectory('objects'); let published = false;
    try { await link(temp, target); published = true; } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const old = await regular(target, limits.maxProcessOutputBytes);
      try {
        const previous = JSON.parse(await old.readFile('utf8')) as StoredRecord;
        check(recordIdentity(previous) === identity, 'ASSET_ID_CONFLICT');
        stored = previous;
      } finally { await old.close(); }
    }
    try { await syncDirectory('records'); }
    catch (error) {
      if (published) {
        const actual = await lstat(target), ours = await lstat(temp);
        check(!actual.isSymbolicLink() && actual.ino === ours.ino && actual.dev === ours.dev, 'OWNER_MISMATCH');
        await unlink(target); await syncDirectory('records');
      }
      throw error;
    }
    return stored;
  };
  return {
    root, limits, ffmpeg: executables[0], ffprobe: executables[1], importRoots, verify, record, object, publish,
    async stage(fn) {
      check(!busy, 'MEDIA_BUSY'); busy = true; let dir: string | undefined; let lock: FileHandle | undefined;
      const lockPath = join(root, '.active-operation');
      try {
        await verify();
        try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
        catch (e: any) { if (e.code === 'EEXIST') throw new MediaError('MEDIA_BUSY'); throw e; }
        await lock.writeFile(JSON.stringify({ owner: token, pid: process.pid, operationId: randomUUID() }));
        dir = await mkdtemp(join(root, 'staging', 'op-')); return await fn(dir);
      } finally {
        try {
          try { if (dir) { await verify(); await rm(dir, { recursive: true, force: true }); } }
          finally {
            if (lock) {
              try {
                await verify(); const actual = await lstat(lockPath), held = await lock.stat();
                check(!actual.isSymbolicLink() && actual.ino === held.ino && actual.dev === held.dev, 'OWNER_MISMATCH');
                await unlink(lockPath);
              } finally { await lock.close(); }
            }
          }
        } finally { busy = false; }
      }
    },
  };
}
export async function copyLocal(s: Storage, input: string, output: string): Promise<void> {
  check(s.importRoots.some(root => { const r = relative(root, input); return r !== '' && !r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r); }), 'OUTSIDE_IMPORT_ROOT');
  const source = await regular(input, s.limits.maxBytes);
  try { await copyHandle(source, output, s.limits); } finally { await source.close(); }
}
export async function writeStream(stream: AsyncIterable<Uint8Array>, path: string, limits: Limits): Promise<void> {
  const file = await open(path, 'wx', 0o600); let timer: ReturnType<typeof setTimeout> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined; let finished = false;
  try {
    iterator = stream[Symbol.asyncIterator]();
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MediaError('INGEST_TIMEOUT')), limits.ingestTimeoutMs); });
    let size = 0;
    for (;;) {
      const chunk = await Promise.race([iterator.next(), expired]);
      if (chunk.done) break;
      check(chunk.value instanceof Uint8Array, 'INVALID_STREAM_CHUNK'); size += chunk.value.byteLength;
      check(size <= limits.maxBytes, 'BYTE_LIMIT');
      await Promise.race([file.writeFile(chunk.value), expired]);
    }
    check(size > 0, 'EMPTY_MEDIA'); await file.sync(); finished = true;
  } finally {
    clearTimeout(timer);
    // A hostile async iterator can hang in return(); do not await its cleanup. Native Readables destroy synchronously.
    if (!finished) {
      (stream as AsyncIterable<Uint8Array> & { destroy?: () => void }).destroy?.();
      if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
    }
    await file.close();
  }
}
export async function copyHandle(source: FileHandle, output: string, limits: Limits): Promise<void> {
  const before = await source.stat(); const dest = await open(output, 'wx', 0o600);
  try {
    const buffer = Buffer.alloc(64 * 1024); let size = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, size); if (!bytesRead) break;
      size += bytesRead; check(size <= limits.maxBytes, 'BYTE_LIMIT'); await dest.writeFile(buffer.subarray(0, bytesRead));
    }
    const after = await source.stat();
    check(size > 0 && before.size === size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'SOURCE_CHANGED');
    await dest.sync();
  } finally { await dest.close(); }
}
