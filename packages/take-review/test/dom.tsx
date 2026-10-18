import {JSDOM} from 'jsdom';
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {TakeReview} from '../src/TakeReview';
import type {TakeReviewProps} from '../src/types';
import {shot,take,asset} from './fixtures';
export {act};
export function defaults(overrides: Partial<TakeReviewProps> = {}): TakeReviewProps {
  return {shot,takes:[take],assets:[asset],exports:[],onInspect:async()=>({inspectionId:'inspection-a'}),onSelect:async()=>{},onExport:async()=>{},...overrides};
}
export async function render(props = defaults()) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>',{url:'http://127.0.0.1/'});
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
  const root: Root = createRoot(dom.window.document.getElementById('root')!);
  const update = async (next: TakeReviewProps) => {await act(async()=>{root.render(<TakeReview {...next}/>);});};
  await update(props);
  return {
    dom, update,
    text:()=>dom.window.document.body.textContent ?? '',
    all:(selector:string)=>Array.from(dom.window.document.querySelectorAll(selector)),
    button:(name:string)=>Array.from(dom.window.document.querySelectorAll('button')).find(b=>b.textContent === name) as HTMLButtonElement | undefined,
    close:async()=>{await act(async()=>root.unmount());dom.window.close();},
    event:async(element:Element, name:string)=>{await act(async()=>{element.dispatchEvent(new dom.window.Event(name,{bubbles:true}));});},
    click:async(button:HTMLButtonElement)=>{await act(async()=>{button.click();});}
  };
}
export function deferred<T>() { let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
