import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createMediaStore,freezeExportSelection,isExportStale} from '../src/index.ts';
import {fixture,ff,id,projectId} from './support.ts';

test('whole asset playback extent includes long audio, rejects its bound and survives frozen export',async t=>{
 const f=await fixture(t),file=join(f.inputs,'long-audio.mp4');
 ff(['-f','lavfi','-i','color=red:size=64x48:rate=10:duration=1','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-c:v','libx264','-threads','1','-c:a','aac',file]);
 const input={projectId,assetId:id(),filename:'long-audio.mp4',origin:'sample' as const,filePath:file};
 const bounded=await createMediaStore({...f.options,root:join(f.dir,'bounded'),limits:{maxDurationSeconds:2}});
 await assert.rejects(bounded.importLocal(input),/DURATION_LIMIT/);
 const store=await createMediaStore(f.options),asset=await store.importLocal(input);
 assert.ok(asset.durationSeconds!>=3.9&&asset.durationSeconds!<=4.1,'must not advertise one second for four seconds of A/V');
 const frozen=freezeExportSelection({projectId,assetId:id(),exportId:id(),shotId:id(),takeId:id(),sourceAssetId:asset.id,sourceSha256:asset.sha256,shotRevision:1,selectionRevision:1,profile:'mp4-copy-v1'});
 const exported=await store.exportSelected(frozen);assert.ok(Math.abs(exported.durationSeconds!-asset.durationSeconds!)<0.001);
});
test('validated equivalent project/take UUID spellings replay without rewriting frozen identity',async t=>{
 const f=await fixture(t),file=join(f.inputs,'sample.mp4');ff(['-f','lavfi','-i','color=red:size=64x48:rate=10:duration=1','-c:v','libx264','-threads','1',file]);
 const store=await createMediaStore(f.options),bytes=await readFile(file);
 const project='abcdefab-cdef-4abc-8abc-abcdefabcdef';
 const request={projectId:project,filename:'SAMPLE.mp4',remoteIdentity:{provider:'fixture',jobId:'OpaqueJobA',outputId:'OutputA'}};
 const stream=()=> (async function*(){yield bytes;})();
 const first=await store.importGeneratedOutput(request,stream());
 const second=await store.importGeneratedOutput({...request,projectId:project.toUpperCase()},stream());assert.equal(first.id,second.id);
 const frozen=freezeExportSelection({projectId:project,assetId:id(),exportId:id(),shotId:id(),takeId:'aabbccdd-abcd-4abc-8abc-abcdefabcdef',sourceAssetId:first.id,sourceSha256:first.sha256,shotRevision:1,selectionRevision:1,profile:'mp4-copy-v1'});
 const before=frozen.snapshotSha256;
 assert.equal(isExportStale(frozen,{shotRevision:1,selectionRevision:1,selectedTakeId:frozen.selection.takeId.toUpperCase()}),false);assert.equal(frozen.snapshotSha256,before);
 await assert.rejects(store.importGeneratedOutput({...request,projectId:' '+project},stream()),/INVALID_ID/);
});

test('no-audio duration keeps the original rational calculation for persisted manifest compatibility',async t=>{
 const f=await fixture(t),store=await createMediaStore(f.options);
 const asset=await store.importLocal({projectId,assetId:id(),filename:'offset.mkv',origin:'sample',filePath:f.video});
 assert.equal(asset.durationSeconds,0.52,'offset timestamps must not introduce a new floating-point manifest value');
});
