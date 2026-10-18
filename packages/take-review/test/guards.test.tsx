import {test} from 'node:test';
import assert from 'node:assert/strict';
import {render,defaults,act,deferred} from './dom';
import {shot,take,asset,frozen} from './fixtures';
import type {TakeReviewProps} from '../src/types';

async function inspect(ui: Awaited<ReturnType<typeof render>>) {
  const video=ui.all('video')[0];
  await ui.event(video,'loadeddata'); await ui.event(video,'playing');
  await ui.click(ui.button('Inspect take')!);
}

test('shot, selection, and source changes invalidate inspection, including late receipts', async () => {
  const variants: Partial<TakeReviewProps>[] = [
    {shot:{...shot,revision:5}}, {shot:{...shot,selectionRevision:3}},
    {assets:[{...asset,sha256:'b'.repeat(64)}]},
    {shot:{...shot,id:'shot-b'},takes:[{...take,shotId:'shot-b'}]},
  ];
  for(const next of variants) {
    const pending=deferred<{inspectionId:string}>();
    const props=defaults({onInspect:()=>pending.promise});
    const ui=await render(props);
    try {
      await inspect(ui);
      await ui.update({...props,...next});
      await act(async()=>pending.resolve({inspectionId:'stale-receipt'}));
      assert.equal(ui.button('Select take')?.disabled,true);
      assert.equal(ui.button('Inspected'),undefined);
    } finally {await ui.close();}
  }
});

test('a playback error also fences an inspection that resolves later', async () => {
  const pending=deferred<{inspectionId:string}>();
  const ui=await render(defaults({onInspect:()=>pending.promise}));
  try {
    await inspect(ui);
    await ui.event(ui.all('video')[0],'error');
    await act(async()=>pending.resolve({inspectionId:'late'}));
    assert.equal(ui.button('Inspected') === undefined,true,'failed media must not gain a late inspection label');
    assert.equal(ui.button('Select take')?.disabled,true);
  } finally {await ui.close();}
});

test('selected takes explain their export path instead of asking to select again', async () => {
  const ui=await render(defaults({shot:{...shot,selectedTakeId:take.id}}));
  try {
    assert.match(ui.text(),/Selected for this shot/);
    assert.equal(ui.button('Selected')?.getAttribute('aria-pressed'),'true');
  } finally {await ui.close();}
});

test('busy and playback errors disable commands without replacing the player or selecting', async () => {
  let calls=0; const props=defaults({onSelect:async()=>{calls++;}});
  const ui=await render(props);
  try {
    await inspect(ui);
    const video=ui.all('video')[0];
    await ui.update({...props,busy:true});
    assert.equal(ui.all('video')[0],video);
    assert.equal(ui.button('Select take')?.disabled,true);
    await ui.update(props);
    await ui.event(video,'error');
    assert.match(ui.text(),/Playback unavailable/);
    assert.equal(ui.button('Select take')?.disabled,true);
    assert.equal(ui.button('Inspected'),undefined);
    assert.equal(calls,0);
  } finally {await ui.close();}
});

test('missing or rejected inspection receipts never authorize selection', async () => {
  for(const onInspect of [async()=>({inspectionId:''}),async()=>{throw new Error('conflict');}]) {
    const ui=await render(defaults({onInspect}));
    try {
      await inspect(ui);
      assert.equal(ui.button('Select take')?.disabled,true);
      assert.match(ui.text(),/Inspection could not be confirmed/);
    } finally {await ui.close();}
  }
});

test('synchronous double clicks cannot duplicate a pending inspection or selection', async () => {
  let inspections=0, selections=0;
  const pending=deferred<void>();
  const ui=await render(defaults({onInspect:async()=>{inspections++;return {inspectionId:'i'};},onSelect:async()=>{selections++;await pending.promise;}}));
  try {
    await ui.event(ui.all('video')[0],'loadeddata');await ui.event(ui.all('video')[0],'playing');
    const button=ui.button('Inspect take')!;
    await act(async()=>{button.click();button.click();});
    assert.equal(inspections,1);
    const select=ui.button('Select take')!;
    await act(async()=>{select.click();select.click();});
    assert.equal(selections,1);
    await act(async()=>pending.resolve());
    assert.equal(ui.button('Select take')?.disabled,true);
  } finally {await ui.close();}
});

test('unconfirmed writes show no selected or ready success and require refresh', async () => {
  const ui=await render(defaults({onSelect:async()=>{throw new Error('stale revision');}}));
  try {
    await inspect(ui); await ui.click(ui.button('Select take')!);
    assert.match(ui.text(),/Selection could not be confirmed/);
    assert.equal(ui.button('Selected'),undefined);
    assert.equal(ui.button('Select take')?.disabled,true);
    assert.equal(ui.button('Export selected take')?.disabled,true);
  } finally {await ui.close();}
  const exporter=await render(defaults({shot:{...shot,selectedTakeId:take.id},onExport:async()=>{throw new Error('timeout');}}));
  try {
    await exporter.click(exporter.button('Export selected take')!);
    assert.match(exporter.text(),/Export could not be confirmed/);
    assert.equal(exporter.all('a[download]').length,0);
    assert.equal(exporter.button('Export selected take')?.disabled,true);
  } finally {await exporter.close();}
});

test('an authoritative failed export readback wins over a late callback resolution', async () => {
  const pending=deferred<void>();
  const props=defaults({shot:{...shot,selectedTakeId:take.id,selectionRevision:3},onExport:()=>pending.promise});
  const ui=await render(props);
  try {
    await ui.click(ui.button('Export selected take')!);
    await ui.update({...props,exports:[{...frozen,status:'failed',assetId:null}]});
    await act(async()=>pending.resolve());
    assert.equal(ui.text().includes('Export requested.'),false,'readback must outrank a late callback');
    assert.match(ui.text(),/Export failed/);
    assert.equal(ui.button('Export selected take')?.disabled,false);
  } finally {await ui.close();}
});

test('unavailable, queued, running and failed exports never expose a download', async () => {
  const selected={...shot,selectedTakeId:take.id,selectionRevision:3};
  const output={...asset,id:'output-a',mediaUrl:'/api/media/output-a'};
  const cases = [
    {exports:[{...frozen,status:'queued' as const}],assets:[asset,output],text:/Queued/},
    {exports:[{...frozen,status:'running' as const}],assets:[asset,output],text:/Exporting/},
    {exports:[{...frozen,status:'failed' as const}],assets:[asset,output],text:/Export failed/},
    {exports:[frozen],assets:[asset],text:/File unavailable/},
    {exports:[frozen],assets:[asset,{...output,mediaUrl:'https:\/\/provider.invalid\/output.mp4'}],text:/File unavailable/},
  ];
  for(const {text,...variant} of cases) {
    const ui=await render(defaults({shot:selected,...variant}));
    try {assert.match(ui.text(),text);assert.equal(ui.all('a[download]').length,0);assert.equal(ui.all('.fl-tr-export video').length,0);}
    finally {await ui.close();}
  }
});

test('staleness is checked independently of the server flag for every frozen dimension', async () => {
  const selected={...shot,selectedTakeId:take.id,selectionRevision:3};
  for(const item of [{...frozen,stale:true},{...frozen,shotRevision:3},{...frozen,selectionRevision:2},{...frozen,takeId:'old-take'}]) {
    const ui=await render(defaults({shot:selected,exports:[item]}));
    try {assert.match(ui.text(),/Out of date/);} finally {await ui.close();}
  }
});

test('origins and literal long identifiers are preserved while other shots stay out of view', async () => {
  const origins=['sample','imported','generated'] as const;
  const assets=origins.map((origin,i)=>({...asset,id:`asset-${i}`,mediaUrl:`/api/media/asset-${i}`,origin,filename:'a'.repeat(240)+'.mp4'}));
  const takes=assets.map((a,i)=>({...take,id:`take-${i}`,assetId:a.id,attemptId:'very-long-attempt-'.repeat(20)}));
  const before=JSON.stringify({assets,takes});
  const ui=await render(defaults({assets,takes:[...takes,{...take,id:'foreign',shotId:'different'}]}));
  try {
    assert.deepEqual(ui.all('.fl-tr-source').map(element=>element.textContent),['Sample','Imported','Generated']);
    assert.equal(ui.all('[data-take-id="foreign"]').length,0);
    assert.equal(ui.all('video').length,3);
    assert.equal(ui.all('.fl-tr-details dd').filter(el=>el.textContent===asset.sha256).length,3);
    assert.equal(ui.all('.fl-tr-details dd').filter(el=>el.textContent==='very-long-attempt-'.repeat(20)).length,3);
    assert.equal(JSON.stringify({assets,takes}),before);
  } finally {await ui.close();}
});

test('a missing selected take and remote media do not enable export or contact the provider', async () => {
  for (const assets of [[],[{...asset,mediaUrl:'https://provider.invalid/video.mp4'}]]) {
    const ui=await render(defaults({shot:{...shot,selectedTakeId:take.id},assets}));
    try {
      assert.equal(ui.all('video').length,0);
      assert.equal(ui.all('a').length,0);
      assert.equal(ui.button('Export selected take')?.disabled,true);
      assert.match(ui.text(),/selected take is unavailable/);
    } finally {await ui.close();}
  }
});
