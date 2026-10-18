import {test} from 'node:test';
import assert from 'node:assert/strict';
import {render,defaults,act,deferred} from './dom';
import {shot,take,asset,frozen} from './fixtures';

test('empty states invite a shot or generation and perform no commands', async () => {
  let calls=0;
  const props=defaults({shot:null,onSelect:async()=>{calls++;},onInspect:async()=>{calls++;return {inspectionId:'i'};},onExport:async()=>{calls++;}});
  const ui=await render(props);
  try {
    assert.match(ui.text(),/Choose a shot/);
    await ui.update({...props,shot,takes:[]});
    assert.match(ui.text(),/No takes yet/);
    assert.match(ui.text(),/Generate/);
    assert.equal(ui.all('video').length,0);
    assert.equal(calls,0);
  } finally {await ui.close();}
});

test('export is explicit and revision-bound; stale results keep their frozen take and owned output', async () => {
  const requests:unknown[]=[];
  const output={...asset,id:'output-a',mediaUrl:'/api/media/output-a',filename:'frozen.mp4'};
  const nextTake={...take,id:'take-b',assetId:'asset-b'};
  const nextAsset={...asset,id:'asset-b',mediaUrl:'/api/media/asset-b',origin:'imported' as const};
  const props=defaults({assets:[asset,output,nextAsset],takes:[take,nextTake],onExport:async request=>{requests.push(request);}});
  const ui=await render(props);
  try {
    assert.equal(ui.button('Export selected take')?.disabled,true);
    assert.match(ui.text(),/No exports yet/);
    const selectedShot={...shot,selectedTakeId:take.id,selectionRevision:3};
    await ui.update({...props,shot:selectedShot});
    await ui.click(ui.button('Export selected take')!);
    assert.deepEqual(requests,[{projectId:shot.projectId,shotId:shot.id,expectedRevision:4,expectedSelectionRevision:3}]);
    assert.equal(ui.all('a[download]').length,0,'request receipt is not a ready export');
    await ui.update({...props,shot:{...selectedShot,revision:5,selectionRevision:4,selectedTakeId:nextTake.id},exports:[frozen]});
    assert.match(ui.text(),/Out of date/);
    const item=ui.all('[data-export-id="export-a"]')[0];
    assert.match(item.textContent!,/Sample/,'source is the original sample, not the current imported take');
    assert.match(item.textContent!,/take-a/);
    assert.equal(item.querySelector('a[download]')?.getAttribute('href'),'/api/media/output-a');
    assert.equal(item.querySelector('video')?.getAttribute('src'),'/api/media/output-a');
    assert.equal(requests.length,1,'edits never create exports');
  } finally {await ui.close();}
});

test('a read-back failed export permits an explicit retry without auto-resubmission', async () => {
  let calls=0;
  const props=defaults({shot:{...shot,selectedTakeId:take.id,selectionRevision:3},onExport:async()=>{calls++;}});
  const ui=await render(props);
  try {
    await ui.click(ui.button('Export selected take')!);
    await ui.update({...props,exports:[{...frozen,status:'failed',assetId:null}]});
    assert.match(ui.text(),/Export failed/);
    assert.equal(calls,1);
    assert.equal(ui.button('Export selected take')?.disabled,false,'a recorded failure is no longer an ambiguous request');
    await ui.click(ui.button('Export selected take')!);
    assert.equal(calls,2);
  } finally {await ui.close();}
});

test('selection requires playback, a server inspection receipt, and an explicit revision-bound click', async () => {
  const inspected: unknown[]=[]; const selected: unknown[]=[];
  const receipt=deferred<{inspectionId:string}>();
  const props=defaults({onInspect:async request=>{inspected.push(request);return receipt.promise;},onSelect:async request=>{selected.push(request);}});
  const ui=await render(props);
  try {
    assert.equal(ui.all('video[controls]').length,1,'renders a real native player');
    const video=ui.all('video')[0];
    assert.equal(video.hasAttribute('autoplay'),false);
    assert.equal(ui.button('Select take')?.disabled,true);
    assert.equal(ui.button('Inspect take')?.disabled,true);
    assert.equal(selected.length,0);
    await ui.event(video,'loadeddata'); await ui.event(video,'playing');
    await ui.click(ui.button('Inspect take')!);
    assert.deepEqual(inspected,[{projectId:shot.projectId,takeId:take.id}]);
    assert.equal(ui.button('Select take')?.disabled,true,'pending inspection is not authority');
    await act(async()=>{receipt.resolve({inspectionId:'inspection-a'});});
    assert.equal(ui.button('Select take')?.disabled,false);
    assert.equal(selected.length,0,'inspection must not select');
    await ui.click(ui.button('Select take')!);
    assert.deepEqual(selected,[{projectId:shot.projectId,shotId:shot.id,takeId:take.id,inspectionId:'inspection-a',expectedRevision:4,expectedSelectionRevision:2}]);
    assert.equal(ui.button('Selected'),undefined,'command resolution is not a workspace readback');
    await ui.update({...props,takes:[take,{...take,id:'take-new'}]});
    assert.equal(selected.length,1,'arrivals do not select');
    assert.equal(ui.all('video')[0],video,'arrivals do not reset playback');
    await ui.update({...props,shot:{...shot,selectedTakeId:take.id,selectionRevision:3}});
    assert.equal(ui.button('Selected')?.getAttribute('aria-disabled'),'true');
  } finally {await ui.close();}
});
