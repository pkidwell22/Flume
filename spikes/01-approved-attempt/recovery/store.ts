import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export type Output = { id: string; path: string; sha256: string; size: number };
export type Scope = { origin: string; key: string; account: string; route: string };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
// Content-addressed bytes are reusable, but NEVER substitute for output provenance.
export async function publishBytes(root: string, scope: Scope, remoteId: string, output: Output) {
  assert.equal(await realpath(root), root);
  const directory = await lstat(root);
  assert(directory.isDirectory() && directory.uid === process.getuid!() && (directory.mode & 0o077) === 0);
  assert.match(output.sha256, /^[a-f0-9]{64}$/);
  assert.match(scope.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert(output.path === `/jobs/${remoteId}/outputs/${output.id.slice(-1)}`);
  const final = path.join(root, `${output.sha256}.simulation`);
  const verify = async () => {
    const stat = await lstat(final); assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.size, output.size);
    assert.equal(hash(await readFile(final)), output.sha256, 'immutable bytes changed');
  };
  try { await verify(); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const staging = path.join(root, `${randomUUID()}.part`);
  const file = await open(staging, 'wx', 0o600);
  try {
    try {
      const response = await fetch(scope.origin + output.path, { redirect: 'error', signal: AbortSignal.timeout(4000),
        headers: { 'idempotency-key': scope.key, 'x-fixture-account': scope.account, 'x-fixture-route': scope.route } });
      assert(response.ok && response.body);
      let size = 0; const digest = createHash('sha256');
      for await (const chunk of response.body) {
        size += chunk.length; assert(size <= 4096 && size <= output.size, 'bounded simulation intake');
        digest.update(chunk); await file.writeFile(chunk);
      }
      assert.equal(size, output.size); assert.equal(digest.digest('hex'), output.sha256);
      await file.sync();
    } finally { await file.close(); }
    try { await link(staging, final); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await verify();
  } finally { await rm(staging, { force: true }); }
}
