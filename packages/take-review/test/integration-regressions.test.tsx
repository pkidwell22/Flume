import {test} from 'node:test';
import assert from 'node:assert/strict';
import {render,defaults} from './dom';
import {shot,take,asset,frozen} from './fixtures';

test('selection readback preserves the player and focused button while invalidating inspection',async()=>{
 const props=defaults();const ui=await render(props);
 try{
  const player=ui.all('video')[0];await ui.event(player,'loadeddata');await ui.event(player,'playing');
  await ui.click(ui.button('Inspect take')!);const select=ui.button('Select take')!;select.focus();
  await ui.click(select);await ui.update({...props,shot:{...shot,selectedTakeId:take.id,selectionRevision:3}});
  assert.ok(ui.all('video')[0]===player,'selection must not remount native playback');
  assert.ok(ui.dom.window.document.activeElement===select,'focus remains at the selection control');
  await ui.update({...props,shot:{...shot,revision:5}});
  assert.equal(ui.button('Select take')?.disabled,true,'old inspection is revision-bound');
 }finally{await ui.close();}
});
test('explicit preview reload clears transient failure but requires fresh playback and inspection',async()=>{
 let exports=0;const output={...asset,id:'output-a',mediaUrl:'/api/media/output-a'};
 const props=defaults({shot:{...shot,selectedTakeId:take.id,selectionRevision:3},assets:[asset,output],exports:[frozen],onExport:async()=>{exports++;}});
 const ui=await render(props);
 try{
  const player=ui.all('video')[0];await ui.event(player,'loadeddata');await ui.event(player,'playing');await ui.click(ui.button('Inspect take')!);await ui.event(player,'error');
  await ui.update({...props});
  assert.ok(ui.button('Reload take preview'),'failure must offer real reload, not an ineffective refresh instruction');
  await ui.click(ui.button('Reload take preview')!);
  assert.equal(ui.button('Inspect take')?.disabled,true);
  const reloaded=ui.all('video')[0];await ui.event(reloaded,'loadeddata');await ui.event(reloaded,'playing');assert.equal(ui.button('Inspect take')?.disabled,false);
  const exported=ui.all('video')[1];await ui.event(exported,'error');
  assert.ok(ui.button('Reload export preview'));await ui.click(ui.button('Reload export preview')!);
  assert.equal(ui.all('a[download]').length,1);assert.equal(exports,0,'reload is read-only, never a new export command');
 }finally{await ui.close();}
});
