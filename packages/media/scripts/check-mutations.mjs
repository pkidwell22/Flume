import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, realpath, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

assert.ok(process.env.TMPDIR, 'explicit owned TMPDIR required');
const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(await realpath(process.env.TMPDIR), 'flume-media-mutations-'));
const mutations = [
  { name: 'first-for-last', file: 'src/derive.ts', old: "mode === 'last' ? source.frames.at(-1)! : source.frames[0]", replacement: 'source.frames[0]', test: 'derivatives.test.ts', pattern: 'last-frame', evidence: /operator: 'notStrictEqual'/ },
  { name: 'ignore-exit-zero-diagnostics', file: 'src/process.ts', old: 'if (errBytes) {', replacement: 'if (false && errBytes) {', test: 'safety.test.ts', pattern: 'exit-zero', evidence: /Missing expected rejection/ },
  { name: 'accept-animated-png-default-image', file: 'src/inspect.ts', old: "if (format.mimeType === 'image/png') await rejectAnimatedPng(file, size);", replacement: '// mutation: skip animation detection', test: 'safety.test.ts', pattern: 'animated PNG', evidence: /Missing expected rejection/ },
  { name: 'ignore-private-dns', file: 'src/download.ts', old: "check(addresses.length > 0 && addresses.length <= 64 && addresses.every(a => isPublicAddress(a.address) && isIP(a.address) === a.family), 'PRIVATE_ADDRESS');", replacement: "check(addresses.length > 0, 'PRIVATE_ADDRESS');", test: 'download.test.ts', pattern: 'bounded download', evidence: /Missing expected rejection/ },
];
const outcomes = [];
try {
  for (const m of mutations) {
    const dir = join(scratch, m.name); await cp(moduleRoot, dir, { recursive: true });
    const path = join(dir, m.file), text = await readFile(path, 'utf8');
    assert.equal(text.split(m.old).length, 2, `one mutation site for ${m.name}`);
    await writeFile(path, text.replace(m.old, m.replacement));
    const result = spawnSync(process.execPath, ['--test','--test-concurrency=1',`--test-name-pattern=${m.pattern}`,join(dir,'test',m.test)], { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000 });
    assert.ifError(result.error); assert.equal(result.status, 1, `${m.name} must be rejected`);
    assert.match(result.stdout + result.stderr, m.evidence, `${m.name} failed for wrong reason`);
    outcomes.push({ mutation: m.name, rejected: true });
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
await assert.rejects(stat(scratch), { code: 'ENOENT' });
console.log(JSON.stringify({ mutations: outcomes, scratchRemoved: true }, null, 2));
