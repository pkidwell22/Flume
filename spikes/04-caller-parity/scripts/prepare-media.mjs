// This is the only media preparation path: fixed IDs from experiment 02.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateFixtures, fixturePath, sha256, FFMPEG, FFPROBE } from '../../02-frame-provenance/fixtures.ts';
import { extract } from '../../02-frame-provenance/media.ts';
import { ContinuityDraft } from '../../02-frame-provenance/continuity.ts';

generateFixtures();
mkdirSync('output', { recursive: true });
const draft = new ContinuityDraft('owned-continuity');
draft.chooseFirst(await extract('vfr', { mode: 'last', range: { start: '5', end: '5.52' } }));
draft.chooseLast(await extract('cfr', { mode: 'first', range: { start: '0', end: '0.24' } }));
const continuity = structuredClone(draft.freeze());
const files = {};
for (const binding of [continuity.first, continuity.last]) {
  binding.assetRevisionId = randomUUID();
  for (const [object, key, id] of [[binding.image, 'path', `image-${binding.image.sha256}`],
    [binding.provenance.image, 'path', `image-${binding.image.sha256}`],
    [binding.provenance.source, 'snapshotPath', `source-${binding.provenance.source.sourceSha256}`]]) {
    if (!files[id]) files[id] = object[key];
    object[key] = id;
  }
  // Keep measured identities/PTS/ranges; paths to raw diagnostics are not identity.
  binding.provenance.evidence = 'experiment-02-owned-extraction';
  binding.provenance.source.evidence = 'experiment-02-owned-inspection';
}
const outputs = ['cfr', 'vfr'].map((id, slot) => {
  const path = resolve(`output/take-${slot}.mp4`);
  execFileSync(FFMPEG, ['-hide_banner','-nostdin','-v','error','-y','-i', fixturePath(id),
    '-map','0:v:0','-vf','setpts=PTS-STARTPTS','-fps_mode','passthrough', '-c:v','libx264',
    '-threads','1','-pix_fmt','yuv420p','-movflags','+faststart','-an', path]);
  const bytes = readFileSync(path);
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v','error','-count_frames','-show_streams','-of','json',path]));
  assert.equal(probe.streams[0].nb_read_frames, '6');
  assert(bytes.length <= 262144);
  return { id: `output-${slot}`, path, sha256: sha256(bytes), size: bytes.length,
    sourceFixture: id, sourceSha256: sha256(readFileSync(fixturePath(id))),
    description: `Owned ${id.toUpperCase()} pattern, six frames; H.264 display derivative, not provider output` };
});
writeFileSync('output/catalog.json', JSON.stringify({ version: 1, continuity, files, outputs }, null, 2));
console.log(JSON.stringify({ catalog: 'output/catalog.json', outputs: outputs.map(({ id,size,sha256 }) => ({id,size,sha256})) }));
