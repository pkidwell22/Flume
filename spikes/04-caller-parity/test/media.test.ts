import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test('owned catalog joins exact last-to-first continuity with two decodable MP4 outputs', () => {
  assert(existsSync('scripts/prepare-media.mjs'), 'owned media preparation is missing');
  execFileSync(process.execPath, ['scripts/prepare-media.mjs']);
  const catalog = JSON.parse(readFileSync('output/catalog.json', 'utf8'));
  const { first, last } = catalog.continuity;
  assert.equal(first.role, 'first-frame');
  assert.equal(first.provenance.request.mode, 'last');
  assert.equal(first.provenance.decoded.pts, '5480');
  assert.equal(first.provenance.decoded.timeBase, '1/1000');
  assert.equal(first.provenance.decoded.sourceTime, '137/25');
  assert.equal(last.role, 'last-frame');
  assert.equal(last.provenance.decoded.pts, '0');
  assert.notEqual(first.image.sha256, first.provenance.decoded.rgbSha256);
  assert.notEqual(first.image.sha256, last.image.sha256);
  for (const binding of [first, last]) {
    assert.equal(hash(readFileSync(catalog.files[binding.image.path])), binding.image.sha256);
    assert.equal(hash(readFileSync(catalog.files[binding.provenance.source.snapshotPath])), binding.provenance.source.sourceSha256);
  }
  assert.equal(catalog.outputs.length, 2);
  for (const output of catalog.outputs) {
    const bytes = readFileSync(output.path);
    assert.equal(hash(bytes), output.sha256);
    const probe = JSON.parse(execFileSync('/opt/homebrew/bin/ffprobe', ['-v','error','-count_frames','-show_streams','-of','json',output.path], {encoding:'utf8'}));
    assert.equal(probe.streams[0].codec_name, 'h264');
    assert.equal(probe.streams[0].nb_read_frames, '6');
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-v','error','-xerror','-i', output.path, '-f','null','-']);
  }
});
