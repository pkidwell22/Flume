import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FlumeClientError} from '@flume/client';
import {emptyWorkspace} from '@flume/domain';
import {WorkspaceController} from '../src/controller.ts';
import type {Command} from '../src/types.ts';
test('actual client outcomeUnknown retains the original command even for a malformed HTTP 200 receipt',async()=>{
 for(const failure of [new FlumeClientError('network_error','lost',{outcomeUnknown:true}),new FlumeClientError('invalid_response','invalid',{status:200,outcomeUnknown:true})]){
  const seen:Command[]=[];const c=new WorkspaceController({listProjects:async()=>[],getWorkspace:async()=>emptyWorkspace(),uploadAsset:async()=>{throw Error('unused');},command:async cmd=>{seen.push(cmd);throw failure;}});
  await assert.rejects(c.createProject('not retried with new ID',''));
  assert.deepEqual(c.getSnapshot().uncertainCommand,seen[0]);
  await assert.rejects(c.retryUncertain());assert.equal(seen[0].commandId,seen[1].commandId);
 }
});

test('save callback retains the accepted revision, not a later passive workspace revision',async()=>{
 const shot={id:'s',projectId:'p',title:'Shot',prompt:'Base',revision:1,selectionRevision:0,selectedTakeId:null,controls:{modelId:'m',durationSeconds:5,resolution:'2K',aspectRatio:'16:9',generateAudio:false},bindings:{firstFrameAssetId:null,lastFrameAssetId:null}};
 let later=false;
 const c=new WorkspaceController({listProjects:async()=>[],getWorkspace:async()=>({...emptyWorkspace(),project:{id:'p',name:'P',brief:'',revision:1},shots:[later?{...shot,revision:3,prompt:'Another actor edit'}:shot]}),uploadAsset:async()=>{throw Error('unused');},command:async cmd=>{later=true;return {commandId:cmd.commandId,projectId:'p',resourceId:'s',revision:2};}});
 await c.openProject('p');c.markDirty('s');const saved=await c.saveShot('s',1,{prompt:'My accepted edit'});
 assert.equal(saved.revision,2);assert.equal(saved.prompt,'My accepted edit');assert.equal(c.getSnapshot().workspace!.shots[0].revision,3);
});
