import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {flushSync} from 'react-dom';
import React,{useState} from 'react';
import {FlumeApp} from '../src/App.tsx';
import {workspaceComponents} from '../src/composition.ts';
import {WorkspaceController} from '../src/controller.ts';
import type {Command,FlumePort,Receipt,Workspace} from '../src/types.ts';
// Match the existing cross-package tsx test setup for UI's classic fallback.
Object.assign(globalThis,{React});
afterEach(cleanup);
HTMLElement.prototype.scrollIntoView=()=>{};
(window.HTMLDialogElement.prototype as any).showModal=function(){this.setAttribute('open','')};
(window.HTMLDialogElement.prototype as any).close=function(){this.removeAttribute('open')};
async function fixture(){
 const shot={id:'s',projectId:'p',title:'One',prompt:'A\n\nB',revision:1,selectionRevision:0,selectedTakeId:null,bindings:{firstFrameAssetId:null,lastFrameAssetId:null},controls:{modelId:'model',durationSeconds:5,resolution:'2K',aspectRatio:'16:9',generateAudio:false}};
 const workspace:Workspace={project:{id:'p',name:'Owned fixture',brief:'',revision:1},shots:[shot,{...shot,id:'s2',title:'Two'}],assets:[],takes:[],exports:[],attempts:[],reviews:[],capabilities:[{modelId:'model',name:'Model',durations:[5],resolutions:['2K'],frameRoles:[],seedSupported:false,availability:'blocked',blocker:'Controlled fixture only'}]};
 const commands:Command[]=[];
 const port:FlumePort={listProjects:async()=>[workspace.project!],getWorkspace:async()=>structuredClone(workspace),uploadAsset:async()=>{throw Error('forbidden')},command:async command=>{commands.push(command);throw Error('unexpected command')}};
 const controller=new WorkspaceController(port);
 await controller.openProject('p');return {controller,commands,workspace,port};
}

test('a capture-phase React flush cannot roll back native input before canonical onChange',async()=>{
 const {controller}=await fixture();
 const {container}=render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false}/>);
 // A native callback boundary can drain React's sync work between capture and
 // target/bubble. jsdom does not run that checkpoint, so make it explicit.
 container.addEventListener('input',()=>flushSync(()=>{}),true);
 const prompt=screen.getByLabelText('Prompt') as HTMLTextAreaElement;
 let atTarget='';prompt.addEventListener('input',()=>{atTarget=prompt.value});
 const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!;
 act(()=>{setter.call(prompt,'A\nB');prompt.dispatchEvent(new window.InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}))});
 assert.equal(atTarget,'A\nB','capture must not restore old controlled text before the target');
 assert.equal(prompt.value,'A\nB');assert.equal(controller.getSnapshot().dirtyShotIds.has('s'),true);
 assert.equal((screen.getByRole('button',{name:'Save changes'}) as HTMLButtonElement).disabled,false);
 assert.equal((screen.getByRole('button',{name:'Review generation'}) as HTMLButtonElement).disabled,true);
});

test('real editor changes immediately hold navigation and review without commands',async()=>{
 const {controller,commands}=await fixture();
 render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false}/>);
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'A\nB'}});
 assert.equal(controller.selectShot('s2'),false);
 await assert.rejects(controller.prepare('s',1),/Save or discard/);
 fireEvent.click(screen.getByRole('button',{name:/Two/}));
 assert.ok(screen.getByRole('dialog',{name:'Leave this shot?'}));
 assert.equal(controller.getSnapshot().activeShotId,'s');assert.deepEqual(commands,[]);
});

test('already-dirty edits during save POST and readback retain the draft and authority',async()=>{
 const {controller,workspace,port}=await fixture();
 let resolvePost!:(receipt:Receipt)=>void;let resolveRead!:(value:Workspace)=>void;
 const post=new Promise<Receipt>(resolve=>{resolvePost=resolve});
 const read=new Promise<Workspace>(resolve=>{resolveRead=resolve});
 let submitted:Extract<Command,{type:'shot.update'}>|undefined;
 port.command=command=>{assert.equal(command.type,'shot.update');submitted=command as typeof submitted;return post};
 port.getWorkspace=()=>read;
 render(<FlumeApp controller={controller} components={workspaceComponents} autoStart={false}/>);
 const prompt=screen.getByLabelText('Prompt') as HTMLTextAreaElement;
 fireEvent.change(prompt,{target:{value:'Submitted'}});
 fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
 fireEvent.change(prompt,{target:{value:'During POST'}});
 assert.equal(prompt.value,'During POST');assert.equal(controller.getSnapshot().dirtyShotIds.has('s'),true);
 await act(async()=>{resolvePost({commandId:submitted!.commandId,projectId:'p',revision:2});await post});
 assert.equal(prompt.value,'During POST','POST completion must not overwrite newer text');
 assert.equal(controller.getSnapshot().dirtyShotIds.has('s'),true);
 fireEvent.change(prompt,{target:{value:'During GET'}});
 workspace.shots[0]={...workspace.shots[0]!,prompt:'Submitted',revision:2};
 await act(async()=>{resolveRead(structuredClone(workspace));await read});
 assert.equal(prompt.value,'During GET','readback must not overwrite newer text');
 assert.equal(controller.getSnapshot().dirtyShotIds.has('s'),true,'every already-dirty edit must fence controller save completion');
 assert.equal((screen.getByRole('button',{name:'Review generation'}) as HTMLButtonElement).disabled,true);
 assert.equal(submitted?.expectedRevision,1);assert.equal(submitted?.patch.prompt,'Submitted');
 await assert.rejects(controller.prepare('s',2),/Save or discard/);
});

test('presentation input under the editor boundary does not acquire shot authority',async()=>{
 const {controller,commands}=await fixture();
 function Search(){const [query,setQuery]=useState('');return <input aria-label="Presentation search" value={query} onChange={event=>setQuery(event.target.value)}/>}
 render(<FlumeApp controller={controller} components={{...workspaceComponents,ShotEditor:Search}} autoStart={false}/>);
 fireEvent.input(screen.getByLabelText('Presentation search'),{target:{value:'Hailuo'}});
 assert.equal(controller.getSnapshot().dirtyShotIds.size,0);
 fireEvent.click(screen.getByRole('button',{name:/Two/}));
 assert.equal(controller.getSnapshot().activeShotId,'s2');assert.equal(screen.queryByRole('dialog',{name:'Leave this shot?'}),null);assert.deepEqual(commands,[]);
});
