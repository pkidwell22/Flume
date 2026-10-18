import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMediaStore, freezeExportSelection } from '../src/index.ts';
import { fixture, projectId, id, ff, FFMPEG } from './support.ts';

test('a real running FFmpeg export holds frozen input while editorial state and the working file change', async t => {
  const f = await fixture(t), path = join(f.inputs, 'selected.mp4');
  ff(['-i',f.video,'-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-fps_mode','passthrough','-movflags','+faststart',path]);
  const store = await createMediaStore(f.options);
  const source = await store.importLocal({ projectId, assetId: id(), filePath: path, filename: 'selected.mp4', origin: 'sample' });
  const measured = await store.inspect({ projectId, assetId: source.id });
  const marker = join(f.dir, 'held.json'), release = join(f.dir, 'release');
  const wrapper = join(f.dir, 'ffmpeg-barrier.cjs');
  // Trusted executable seam ONLY in this isolated test. The real FFmpeg is already running on a
  // bounded pipe, with EOF/payload withheld; a tiny file's progress=end cannot fake this barrier.
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawn,spawnSync}=require('node:child_process');\nconst fs=require('node:fs');\nconst crypto=require('node:crypto');\nconst args=process.argv.slice(2);\nconst actual=${JSON.stringify(FFMPEG)};\nif(!args.at(-1).endsWith('/export.mp4')) {const r=spawnSync(actual,args,{stdio:'inherit',timeout:10000}); process.exit(r.status??1);}\nconst at=args.indexOf('-i')+1;\nconst bytes=fs.readFileSync(args[at]); args[at]='pipe:0';\nconst child=spawn(actual,args,{stdio:['pipe','inherit','inherit']});\nlet poll; const deadline=setTimeout(()=>child.kill('SIGKILL'),5000);\nchild.stdin.on('error',()=>{}); child.on('error',()=>process.exit(1));\nchild.on('spawn',()=>{child.stdin.write(bytes.subarray(0,32)); fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid,inputSha256:crypto.createHash('sha256').update(bytes).digest('hex')})); poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(poll);child.stdin.end(bytes.subarray(32));}},10);});\nchild.on('close',code=>{clearTimeout(deadline);clearInterval(poll);process.exit(code??1);});\n`, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  const barrierStore = await createMediaStore({ ...f.options, ffmpegPath: wrapper });
  const selection = { exportId: id(), assetId: id(), projectId, shotId: id(), takeId: id(), sourceAssetId: source.id, sourceSha256: source.sha256, shotRevision: 4, selectionRevision: 1, profile: 'mp4-copy-v1' as const };
  const snapshot = freezeExportSelection(selection); const pending = barrierStore.exportSelected(snapshot);
  void pending.catch(() => {}); let held: { pid: number; inputSha256: string } | undefined;
  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try { held = JSON.parse(await readFile(marker, 'utf8')); break; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      await delay(10);
    }
    assert.ok(held, 'real FFmpeg input barrier observed'); process.kill(held.pid, 0);
    assert.equal(held.inputSha256, source.sha256);
    selection.takeId = id(); selection.selectionRevision++;
    await writeFile(path, 'editor replaced working source while FFmpeg is held');
    process.kill(held.pid, 0);
  } finally { await writeFile(release, 'release owned pipe'); await pending.catch(() => {}); }
  const result = await pending;
  const exported = await store.inspect({ projectId, assetId: result.id });
  assert.deepEqual(exported.frames.map(f => f.rgbSha256), measured.frames.map(f => f.rgbSha256));
  assert.equal((result.provenance?.selection as any).takeId, snapshot.selection.takeId);
  assert.throws(() => process.kill(held!.pid, 0), /ESRCH/, 'owned FFmpeg reaped');
  t.diagnostic(JSON.stringify({ realFfmpegHeldDuringEdits: true, frozenFramesVerified: exported.frames.length, processReaped: true }));
});
