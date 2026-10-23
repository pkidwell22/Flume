import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false})});
const React=await import('react');
const {cleanup,fireEvent,render}=await import('@testing-library/react');
const {HomeShowreel}=await import('../src/HomeShowreel.tsx');
test.afterEach(()=>{cleanup();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});});
for(const transition of ['replace','pause','hide'] as const){
 test(`late play fulfillment is stopped after ${transition}`,async()=>{
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
  let first:HTMLMediaElement|undefined,stopped=0;
  let resolve!:()=>void;const pending=new Promise<void>(done=>{resolve=done;});
  Object.defineProperty(dom.window.HTMLMediaElement.prototype,'play',{configurable:true,value:function(this:HTMLMediaElement){if(!first){first=this;return pending;}return Promise.resolve();}});
  Object.defineProperty(dom.window.HTMLMediaElement.prototype,'pause',{configurable:true,value:function(this:HTMLMediaElement){if(this===first)stopped++;}});
  const view=render(<HomeShowreel/>);
  if(transition==='replace')fireEvent.click(view.getByRole('button',{name:'Next film'}));
  if(transition==='pause')fireEvent.click(view.getByRole('button',{name:'Pause showreel'}));
  if(transition==='hide'){Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});fireEvent(document,new window.Event('visibilitychange'));}
  const before=stopped;await React.act(async()=>resolve());assert.ok(stopped>before);
 });
}
