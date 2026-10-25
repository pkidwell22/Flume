import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceController } from '../src/controller.ts';
import { createAuthoringApi, proposalFromWire } from '../src/authoring-api.ts';
import type { FlumePort, Workspace } from '../src/types.ts';

const projectId='6a1f5c1e-0000-4000-8000-000000000001';
const proposalId='6a1f5c1e-0000-4000-8000-000000000002';
const otherProject='6a1f5c1e-0000-4000-8000-000000000003';
const fixture={id:proposalId,projectId,status:'unknown',revision:4,items:[{itemId:'cut-1',title:'Fixture cut',direction:'Fixture direction',startDescription:'Fixture start',endDescription:'Fixture end',durationSeconds:5,continuityNotes:'',state:'unknown',shotId:null}],failure:null};
function workspace(id=projectId):Workspace{return {project:{id,name:'Recovery fixture',brief:'',revision:1},shots:[],assets:[],takes:[],attempts:[],reviews:[],exports:[],capabilities:[]};}
function setup(){
 const bookmarks=new Map<string,string>();
 const store={read:(p:string)=>bookmarks.get(p)??null,write:(p:string,id:string|null)=>{if(id)bookmarks.set(p,id);else bookmarks.delete(p);}};
 const calls:Array<{method:string;url:string}>=[];
 const port:FlumePort={listProjects:async()=>[workspace().project!],getWorkspace:async(p)=>workspace(p),command:async()=>{throw new Error('Recovery must not write commands');},uploadAsset:async()=>{throw new Error('Recovery must not upload');}};
 const authoring=createAuthoringApi(async(input,init)=>{
  calls.push({method:init?.method??'GET',url:String(input)});
  assert.equal(init?.method??'GET','GET','Recovery cannot replay POSTs');
  return new Response(JSON.stringify(fixture),{status:200,headers:{'content-type':'application/json'}});
 });
 return {bookmarks,store,calls,port,authoring};
}

test('a recreated workspace restores its saved proposal by GET only, preserving unknown status',async()=>{
 const s=setup();
 const first=new WorkspaceController(s.port,s.authoring,s.store);
 await first.openProject(projectId);await first.openProposal(proposalId);
 assert.equal(s.bookmarks.get(projectId),proposalId,'only the server identity should be remembered');
 const reopened=new WorkspaceController(s.port,s.authoring,s.store);
 await reopened.openProject(projectId);
 assert.equal(reopened.getSnapshot().authoring.proposal?.id,proposalId);
 assert.equal(reopened.getSnapshot().authoring.proposal?.status,'unknown');
 assert.equal(s.calls.length,2);assert.ok(s.calls.every(c=>c.method==='GET'));
 });

 test('switching projects clears the visible proposal without deleting the previous bookmark',async()=>{
 const s=setup();const controller=new WorkspaceController(s.port,s.authoring,s.store);
 await controller.openProject(projectId);await controller.openProposal(proposalId);
 await controller.openProject(otherProject);
 assert.equal(controller.getSnapshot().authoring.proposal,null);
 assert.equal(s.bookmarks.get(projectId),proposalId);
 assert.equal(s.calls.length,1,'the other project has no saved identity to read');
 });

test('failed recovery keeps the project usable and the identity available for read-only retry',async()=>{
 const s=setup();s.bookmarks.set(projectId,proposalId);
 const api:typeof s.authoring={...s.authoring,readProposal:async()=>{throw new Error('Disconnected');}};
 const controller=new WorkspaceController(s.port,api,s.store);
 await controller.openProject(projectId);
 assert.equal(controller.getSnapshot().phase,'ready');
 assert.equal(controller.getSnapshot().authoring.recovery?.phase,'error');
 assert.equal(s.bookmarks.get(projectId),proposalId);
 api.readProposal=s.authoring.readProposal;
 await controller.restoreStoryboard();
 assert.equal(controller.getSnapshot().authoring.proposal?.id,proposalId);
});

test('late recovery cannot leak into another project or leave its controls busy',async()=>{
 const s=setup();s.bookmarks.set(projectId,proposalId);
 let finish!:(p:ReturnType<typeof proposalFromWire>)=>void;
 const api={...s.authoring,readProposal:()=>new Promise<ReturnType<typeof proposalFromWire>>(r=>{finish=r;})};
 const controller=new WorkspaceController(s.port,api,s.store);
 const pending=controller.openProject(projectId);await new Promise(r=>setImmediate(r));
 assert.equal(controller.getSnapshot().busy,'storyboard.restore');
 await controller.openProject(otherProject);
 assert.equal(controller.getSnapshot().busy,null);
 finish(proposalFromWire(fixture));await pending;
 assert.equal(controller.getSnapshot().workspace?.project?.id,otherProject);
 assert.equal(controller.getSnapshot().authoring.proposal,null);
 assert.equal(controller.getSnapshot().authoring.recovery,null);
});

test('unavailable browser storage never makes a successful server read or project open fail',async()=>{
 const s=setup();const unavailable={read:()=>{throw new Error('storage disabled');},write:()=>{throw new Error('quota');}};
 const controller=new WorkspaceController(s.port,s.authoring,unavailable);
 await controller.openProject(projectId);assert.equal(controller.getSnapshot().phase,'ready');
 await assert.doesNotReject(()=>controller.openProposal(proposalId));
 assert.equal(controller.getSnapshot().authoring.proposal?.id,proposalId);
 assert.match(controller.getSnapshot().notice??'',/storage is unavailable/i);
});

test('proposal read refuses a mismatched server project or proposal identity',async()=>{
 for(const change of [{projectId:otherProject},{id:otherProject}]){
  const api=createAuthoringApi(async()=>new Response(JSON.stringify({...fixture,...change}),{status:200}));
  await assert.rejects(()=>api.readProposal(proposalId,projectId),/identity/i);
 }
});

test('leaving the workspace during recovery releases busy state and ignores the late result',async()=>{
 const s=setup();s.bookmarks.set(projectId,proposalId);
 let finish!:(p:ReturnType<typeof proposalFromWire>)=>void;
 const api={...s.authoring,readProposal:()=>new Promise<ReturnType<typeof proposalFromWire>>(r=>{finish=r;})};
 const controller=new WorkspaceController(s.port,api,s.store);
 const pending=controller.openProject(projectId);await new Promise(r=>setImmediate(r));
 controller.cancelPendingNavigation();
 assert.equal(controller.getSnapshot().busy,null);
 finish(proposalFromWire(fixture));await pending;
 assert.equal(controller.getSnapshot().authoring.proposal,null);
});
