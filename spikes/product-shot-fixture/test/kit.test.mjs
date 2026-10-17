import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const kit = await import('../kit.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
let built;
const generated = async () => built ??= await kit.build();
const rgb = file => execFileSync('/opt/homebrew/bin/ffmpeg', [
  '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 4_000_000 });

// Dynamic loading makes the initial RED an explicit missing-behavior assertion.
const scene = await import('../scene.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('fixed original scene renders deterministic, different camera positions', () => {
  assert.equal(typeof scene.render, 'function', 'missing owned scene renderer');
  const wide = scene.render(0);
  const tail = scene.render(23);
  const end = scene.render(47);
  assert.equal(wide.length, 960 * 540 * 3);
  assert.deepEqual(wide, scene.render(0));
  assert.notDeepEqual(wide, tail);
  assert.notDeepEqual(tail, end);
  assert.throws(() => scene.render(-1), /FIXTURE_CAMERA_ONLY/);
  assert.throws(() => scene.render(48), /FIXTURE_CAMERA_ONLY/);
});

test('first reference is the measured last presented source frame, not the opening frame', async () => {
  assert.equal(typeof kit.build, 'function', 'missing actual media kit builder');
  const { dir, manifest: m } = await generated();
  assert.equal(m.source.streamIndex, 0);
  assert.equal(m.source.timeBase, '1/1000');
  assert.deepEqual(m.source.frames.map(f => f.pts), [
    '0','83','167','250','333','417','500','583','667','750','833','917',
    '1000','1083','1167','1250','1333','1417','1500','1583','1667','1750','1833','1917',
  ]);
  assert.equal(new Set(m.source.frames.map(f => f.rgbSha256)).size, 24);
  assert.equal(m.source.eof, 'observed-clean-decode');
  const first = m.bindings[0];
  assert.equal(first.role, 'first_frame');
  assert.equal(first.provenance.kind, 'actual-decoded-source-frame');
  assert.equal(first.provenance.sourceSha256, sha(await readFile(join(dir, 'prior.mkv'))));
  assert.equal(first.provenance.streamIndex, 0);
  assert.equal(first.provenance.timeBase, '1/1000');
  assert.equal(first.provenance.frameIndex, 23);
  assert.equal(first.provenance.pts, '1917');
  // Independent expected pixels: render the literal authored camera step, not the inspector's chosen index.
  assert.deepEqual(rgb(join(dir, 'first-reference.png')), scene.render(23));
  assert.notDeepEqual(rgb(join(dir, 'first-reference.png')), rgb(join(dir, 'prior-opening.png')));
  assert.equal(first.original.sha256, sha(await readFile(join(dir, 'first-reference.png'))));
  assert.equal(first.original.bytes, (await readFile(join(dir, 'first-reference.png'))).length);
  assert.equal(first.original.width, 960);
  assert.equal(first.original.height, 540);
  const extraction = await readFile(join(dir, 'evidence/final-extraction.stdout'), 'utf8');
  assert.match(extraction, /#tb 0: 1\/1000/);
  assert.match(extraction, new RegExp(`0,\\s*1917,\\s*1917,.*${sha(scene.render(23))}`));
});

test('end reference is a separate, closer same-scene last_frame binding without preparation transforms', async () => {
  const { dir, manifest: m } = await generated();
  assert.deepEqual(m.bindings.map(b => b.role), ['first_frame', 'last_frame']);
  const [first, end] = m.bindings;
  assert.deepEqual(first.prepared, first.original);
  assert.deepEqual(end.prepared, end.original);
  assert.equal(end.provenance.kind, 'same-scene-render');
  assert.equal(end.provenance.cameraStep, 47);
  assert.equal(end.provenance.sceneRevision, first.provenance.sceneRevision);
  assert.equal(end.original.mime, 'image/png');
  assert.equal(end.original.width / end.original.height, 16 / 9);
  assert.equal(end.preparation.operation, 'identity-no-transform');
  assert.equal(end.preparation.routeAcceptance, 'unverified');
  assert.equal(end.original.sha256, sha(await readFile(join(dir, 'end-reference.png'))));
  assert.notEqual(first.original.sha256, end.original.sha256);
  const firstRGB = rgb(join(dir, 'first-reference.png')), endRGB = rgb(join(dir, 'end-reference.png'));
  assert.deepEqual(endRGB, scene.render(47));
  const redArea = pixels => {
    let n = 0;
    for (let i = 0; i < pixels.length; i += 3) if (pixels[i] > pixels[i+1]*2 && pixels[i] > 70) n++;
    return n;
  };
  const ratio = redArea(endRGB)/redArea(firstRGB);
  assert.ok(ratio > 1.10 && ratio < 1.35, `modest perspective push-in area ratio: ${ratio}`);
  assert.equal(m.provenance.providerCall, false);
  assert.equal(m.provenance.upload, false);
  assert.equal(m.provenance.importedMedia, false);
});

test('media process gate rejects even exit-zero diagnostics and process failures', async () => {
  assert.equal(typeof kit.requireCleanProcess, 'function', 'missing fail-closed diagnostic gate');
  const { dir } = await generated();
  const warning = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v','warning','-i',join(dir,'first-reference.png'),
    '-frames:v','1',join(dir,'diagnostic-without-sequence-pattern.png')]);
  assert.equal(warning.status, 0);
  assert.ok(warning.stderr.length > 0, 'real FFmpeg warning must be observed');
  assert.throws(() => kit.requireCleanProcess(warning), /MEDIA_PROCESS_DIAGNOSTIC/);
  const failure = spawnSync('/opt/homebrew/bin/ffprobe', ['-intentionally-invalid-fixture-option']);
  assert.notEqual(failure.status, 0);
  assert.throws(() => kit.requireCleanProcess(failure), /MEDIA_PROCESS_FAILED/);
  const absent = spawnSync(join(dir, 'nonexistent-tool'), []);
  assert.ok(absent.error);
  assert.throws(() => kit.requireCleanProcess(absent), /MEDIA_PROCESS_FAILED/);
});

test('PNG gallery displays the actual opening, continuity input and end input in order', async () => {
  const { dir, manifest: m } = await generated();
  assert.ok(m.gallery, 'missing local PNG gallery');
  assert.deepEqual(m.gallery.panels.map(p => p.path), ['prior-opening.png','first-reference.png','end-reference.png']);
  const pictures = await Promise.all(m.gallery.panels.map(p => readFile(join(dir,p.path))));
  assert.deepEqual(m.gallery.panels.map(p => p.sha256), pictures.map(sha));
  const sheet = await readFile(join(dir,'gallery.png'));
  assert.equal(m.gallery.sha256, sha(sheet));
  assert.equal(sheet.readUInt32BE(16), 2880);
  assert.equal(sheet.readUInt32BE(20), 540);
  const panels = m.gallery.panels.map(p => rgb(join(dir,p.path)));
  const actual = execFileSync('/opt/homebrew/bin/ffmpeg', ['-v','error','-i',join(dir,'gallery.png'),
    '-f','rawvideo','-pix_fmt','rgb24','-'], { maxBuffer: 8_000_000 });
  for (let y = 0; y < 540; y++) for (let p = 0; p < 3; p++) {
    assert.deepEqual(actual.subarray((y*2880+p*960)*3,(y*2880+(p+1)*960)*3), panels[p].subarray(y*960*3,(y+1)*960*3));
  }
  const html = await readFile(join(dir,'index.html'), 'utf8');
  assert.match(html, /Synthetic illustration/);
  assert.match(html, /first_frame/);
  assert.match(html, /last_frame/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('CLI rejects extra inputs rather than accepting arbitrary media or output paths', () => {
  const result = spawnSync(process.execPath, ['kit.mjs', '--input', '/not/accepted'], { cwd: new URL('..', import.meta.url) });
  assert.equal(result.status, 2);
  assert.match(result.stderr.toString(), /Usage: node kit.mjs/);
});

test('fresh CLI build reproduces complete media identities and binding roles byte-for-byte', async () => {
  const { manifest: first } = await generated();
  const result = spawnSync(process.execPath, ['kit.mjs'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 60_000, maxBuffer: 1_000_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), 'missing CLI build result');
  const summary = JSON.parse(result.stdout);
  const second = JSON.parse(await readFile(summary.manifestPath, 'utf8'));
  assert.deepEqual(second, first);
  assert.equal(summary.sourcePath, join(summary.dir, 'prior.mkv'));
  for (const binding of second.bindings) {
    const bytes = await readFile(join(summary.dir, binding.prepared.path));
    assert.equal(binding.prepared.sha256, sha(bytes));
    assert.equal(binding.prepared.bytes, bytes.length);
    assert.equal(binding.prepared.width, bytes.readUInt32BE(16));
    assert.equal(binding.prepared.height, bytes.readUInt32BE(20));
  }
  assert.equal(second.revisions.sceneSha256, sha(await readFile(new URL('../scene.mjs', import.meta.url))));
  assert.equal(second.revisions.kitSha256, sha(await readFile(new URL('../kit.mjs', import.meta.url))));
});
