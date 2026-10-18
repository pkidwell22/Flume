import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import * as cli from '../src/index.js';
import { CommandSchema } from '@flume/domain';

const command = { type: 'project.create', commandId: '42B3DC54-6022-473E-94F2-2417A5AE42E4', name: 'Film', brief: '' };
const projectId = '00000001-0000-4000-8000-000000000001';
const assetId = '00000002-0000-4000-8000-000000000002';
const reviewId = '00000003-0000-4000-8000-000000000003';
const receipt = { commandId: command.commandId, projectId, resourceId: projectId, revision: 0 };
async function run(args: string[], input = '', env = {}) {
  let stdout = ''; let stderr = '';
  const code = await (cli as any).runCli(args, { stdin: (async function* () { yield input; })(), stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } }, env });
  return { code, stdout, stderr };
}

test('CLI is a real same-boundary JSON client, not another command runtime', async () => {
  assert.ok('runCli' in cli, 'CLI entry is exported');
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; }); req.on('end', () => {
      seen.push(req.url!); if (req.method === 'POST') assert.deepEqual(JSON.parse(body), command);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'POST' ? receipt : []));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const args = ['--base-url', `http://127.0.0.1:${address.port}`];
  try {
    assert.deepEqual(await run([...args, 'projects']), { code: 0, stdout: '[]\n', stderr: '' });
    const result = await run([...args, 'command', '-'], JSON.stringify(command));
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), receipt); assert.equal(result.stderr, '');
    assert.deepEqual(seen, ['/api/projects', '/api/commands']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('CLI cannot approve, forge identity, repair IDs or accept secret flags', async () => {
  assert.ok('runCli' in cli);
  const approve = { type: 'generation.approve', commandId: command.commandId, projectId, reviewId, maxAttempts: 1, maxCostUsd: '10' };
  assert.equal(CommandSchema.safeParse(approve).success, true, 'approval fixture must not fail merely because its resource IDs are invalid');
  for (const input of [approve, { ...command, actor: 'operator' }, { ...command, commandId: 'not-a-uuid' }]) {
    const result = await run(['command', '-'], JSON.stringify(input));
    assert.notEqual(result.code, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr.includes('not-a-uuid'), false);
  }
  const result = await run(['--token', 'must-not-log', 'projects']);
  assert.equal(result.code, 2); assert.equal(result.stderr.includes('must-not-log'), false);
  assert.equal((await run(['--help'])).code, 0);
});

test('bounded file commands and uploads reject symlinks and preserve exact local bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flume-cli-'));
  const path = join(directory, 'command.json');
  let posted = 0; let uploaded = '';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    let result: unknown = receipt;
    if (req.url === '/api/assets') {
      const form = await new Request('http://127.0.0.1/api/assets', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body }).formData();
      uploaded = await (form.get('file') as File).text();
      assert.equal(form.get('projectId'), projectId);
      result = { id: assetId, projectId, filename: 'image.png', kind: 'image', origin: 'imported', sha256: 'a'.repeat(64), mediaUrl: `/api/media/${assetId}`, width: 1, height: 1 };
    } else { posted++; assert.deepEqual(JSON.parse(body.toString()), command); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const env = { FLUME_API_URL: `http://127.0.0.1:${address.port}` };
  try {
    await writeFile(path, JSON.stringify(command));
    assert.equal((await run(['command', path], '', env)).code, 0);
    await symlink(path, join(directory, 'link.json'));
    assert.equal((await run(['command', join(directory, 'link.json')], '', env)).code, 2);
    assert.equal((await run(['command', directory], '', env)).code, 2);
    assert.equal((await run(['command', '-'], ' '.repeat(1024 * 1024 + 1), env)).code, 2);
    await writeFile(join(directory, 'image.png'), 'local bytes (fixture, not a decoded image)');
    assert.equal((await run(['upload', projectId, join(directory, 'image.png')], '', env)).code, 0);
    assert.equal(uploaded, 'local bytes (fixture, not a decoded image)'); assert.equal(posted, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test('built executable returns JSON UUIDs and structured nonzero failures without global tools', async () => {
  function exec(args: string[], input = '') {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['dist/bin.js', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
    });
  }
  const result = await exec(['id']); assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).commandId, /^[0-9a-f-]{36}$/); assert.equal(result.stderr, '');
  const invalid = await exec(['command', '-'], '{}'); assert.equal(invalid.code, 2); assert.equal(invalid.stdout, ''); assert.equal(JSON.parse(invalid.stderr).code, 'invalid_input');
});
