import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<body></body>',{url:'http://127.0.0.1:4310'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const React=await import('react');const {createRoot}=await import('react-dom/client');const {fireEvent}=await import('@testing-library/react');const {ChatPanel}=await import('../src/ChatPanel.tsx');
after(()=>dom.window.close());
const conversation={id:'10000000-0000-4000-8000-000000000010',projectId:'10000000-0000-4000-8000-000000000001',title:'Scene',modelId:'google/gemini-2.5-flash-lite',messages:[]};
const button=(text:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent===text) as HTMLButtonElement;
async function mount(overrides:Record<string,unknown>){const element=document.createElement('div');document.body.append(element);const root=createRoot(element);const port:any={models:async()=>[conversation.modelId],list:async()=>[conversation],create:async()=>conversation,rename:async()=>conversation,stream:async()=>{},...overrides};await React.act(async()=>root.render(<ChatPanel port={port} project={{id:conversation.projectId,name:'Film'}} dirty={false} assets={[]}/>));return{root,element,async close(){await React.act(async()=>root.unmount());element.remove();}};}
async function send(){await React.act(async()=>fireEvent.change(document.querySelector('textarea')!,{target:{value:'Hello'}}));await React.act(async()=>button('Send').click());}

test('in-progress replay shows saved partial text without a fake working Stop control',async()=>{
 const ui=await mount({stream:async(_i:any,_s:any,emit:any)=>emit({event:'in_progress',data:{assistantMessageId:'server-assistant',status:'in_progress',content:'Already running partial',usage:null}})});
 try{await send();assert.equal(Boolean(button('Stop')),false);assert.equal(document.querySelector('[data-role="assistant"] p')?.textContent,'Already running partial');assert.equal((document.querySelector('[data-role="assistant"]') as HTMLElement).dataset.messageId,'server-assistant');assert.match(document.body.textContent??'',/running on the server/i);assert.equal(button('Send').disabled,true);}finally{await ui.close();}
});

for(const event of ['done','stopped','error']) test(`${event} replay restores authoritative saved text`,async()=>{
 const ui=await mount({stream:async(_i:any,_s:any,emit:any)=>emit({event,data:{assistantMessageId:'saved-assistant',content:'Saved server text',usage:null,message:event==='error'?'Fixture provider error':null}})});
 try{await send();assert.equal(document.querySelector('[data-role="assistant"] p')?.textContent,'Saved server text');assert.equal((document.querySelector('[data-role="assistant"]') as HTMLElement).dataset.messageId,'saved-assistant');assert.equal(Boolean(button('Stop')),false);}finally{await ui.close();}
});

test('an owned stream holds rename and new-chat controls',async()=>{
 let finish!:()=>void;
 const ui=await mount({stream:async()=>new Promise<void>(r=>{finish=r;})});
 try{await send();assert.equal(button('Rename').disabled,true);assert.equal(button('New chat').disabled,true);}finally{await React.act(async()=>finish?.());await ui.close();}
});

test('late rename cannot replace a streaming transcript',async()=>{
 let resolveRename!:(value:any)=>void,emit!:(event:any)=>void,finish!:()=>void;
 const ui=await mount({rename:()=>new Promise(r=>{resolveRename=r;}),stream:async(_i:any,_s:any,e:any)=>{emit=e;await new Promise<void>(r=>{finish=r;});}});
 window.prompt=()=> 'Renamed';
 try{
  await React.act(async()=>button('Rename').click());await send();
  await React.act(async()=>emit({event:'delta',data:{text:'First '}}));
  await React.act(async()=>resolveRename({...conversation,title:'Renamed'}));
  await React.act(async()=>emit({event:'delta',data:{text:'second'}}));
  assert.equal(document.querySelector('[data-role="assistant"] p')?.textContent,'First second');
 }finally{await React.act(async()=>finish?.());await ui.close();}
});
