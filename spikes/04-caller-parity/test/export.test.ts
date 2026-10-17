import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './support.ts';
import { startProvider } from '../provider.ts';
import { launchWorker } from '../worker.ts';
import { digest } from '../service.ts';
import { hash } from '../../01-approved-attempt/dist/src/contracts.js';

test('edit and selection during actual FFmpeg export mark stale without rewriting frozen inputs',async t=>{
  const {service:s,catalog,fresh,cleanup}=await setup(t);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const look=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:'first-look'});
  await s.command(s.credentials.human,{type:'approve',revision:1,inspectionId:look.id});
  await s.command(s.credentials.agent,{type:'submit',revision:1,commandId:crypto.randomUUID()});
  const worker=launchWorker({origin:provider.origin,storage:s.storage,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'});
  cleanup.push(()=>worker.stop());assert.equal(await worker.done,'ready');
  const takes=await fresh('SELECT * FROM recovery.takes ORDER BY output_id');
  await assert.rejects(s.command(s.credentials.human,{type:'export',revision:1,selectionRevision:0}),/SELECTION_REQUIRED/);
  const inspect=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:takes[0].id});
  await s.command(s.credentials.human,{type:'select',revision:1,selectionRevision:0,takeId:takes[0].id,inspectionId:inspect.id});
  const job=await s.command(s.credentials.human,{type:'export',revision:1,selectionRevision:1});
  const [before]=await fresh('SELECT * FROM parity.exports WHERE id=$1',[job.id]);
  assert.equal(before.snapshot_hash,hash(before.snapshot));
  await assert.rejects(fresh("UPDATE parity.exports SET snapshot='{}' WHERE id=$1",[job.id]),/IMMUTABLE_EXPORT/);
  assert(s.renderExport,'actual export runner is missing');
  let progress=false;
  const result=await s.renderExport(job.id,async(child:any)=>{
    progress=true;
    assert.match(child.spawnfile,/ffmpeg$/);
    {
      assert.equal((await fresh('SELECT status FROM parity.exports WHERE id=$1',[job.id]))[0].status,'running');
      const next=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:takes[1].id});
      await s.command(s.credentials.human,{type:'select',revision:1,selectionRevision:1,takeId:takes[1].id,inspectionId:next.id});
      await s.command(s.credentials.human,{type:'edit',revision:1,prompt:'Edited while FFmpeg is running'});
      const [during]=await fresh('SELECT * FROM parity.exports WHERE id=$1',[job.id]);
      assert.equal(during.stale,true);assert.deepEqual(during.snapshot,before.snapshot);
      assert.doesNotThrow(()=>process.kill(child.pid,0));
    }
  });
  assert(progress,'barrier must hold a live FFmpeg process before input EOF');
  assert.equal(result.status,'complete');assert.equal(result.stale,true);
  assert.deepEqual(result.snapshot,before.snapshot);assert.equal(result.snapshot_hash,before.snapshot_hash);
  assert.equal(result.snapshot.take.id,takes[0].id);
  const exported=path.join(s.storage,`export-${job.id}.mp4`);
  assert.equal(digest(await readFile(exported)),result.output_sha256);
  const raw=(file:string)=>execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-i',file,'-f','rawvideo','-pix_fmt','rgb24','-']);
  assert.equal(digest(raw(exported)),digest(raw(path.join(s.storage,`${takes[0].sha256}.simulation`))));
  assert.notEqual(digest(raw(exported)),digest(raw(path.join(s.storage,`${takes[1].sha256}.simulation`))));
});
