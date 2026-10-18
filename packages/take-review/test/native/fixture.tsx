import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TakeReview} from '../../src';
import '../../src/styles.css';
import type {ReviewExport, ReviewShot} from '../../src';
import {asset,shot,take} from '../fixtures';

declare global {
  interface Window {
    fixtureHashes: {a:string;b:string};
    fixture: {events: Array<Record<string,unknown>>; edit:()=>void; ready:()=>void; empty:()=>void};
  }
}
// Explicit test-owned sample corpus. This fixture is not a provider or product server.
const assets=[
  {...asset,filename:'sample-motion-study.mp4',sha256:window.fixtureHashes.a,durationSeconds:3},
  {...asset,id:'asset-b',mediaUrl:'/api/media/asset-b',filename:'sample-reverse-study.mp4',sha256:window.fixtureHashes.b,durationSeconds:3},
  {...asset,id:'output-a',mediaUrl:'/api/media/output-a',filename:'sample-frozen-export.mp4',sha256:window.fixtureHashes.a,durationSeconds:3},
];
const takes=[{...take,attemptId:'long-attempt-identity-'.repeat(20)},{...take,id:'take-b',assetId:'asset-b'}];
function Fixture() {
  const [current,setCurrent]=useState<ReviewShot>(shot);
  const [exports,setExports]=useState<ReviewExport[]>([]);
  const [shown,setShown]=useState(true);
  window.fixture={
    events:window.fixture?.events ?? [],
    edit:()=>setCurrent(s=>({...s,revision:s.revision+1})),
    ready:()=>setExports(items=>items.map(item=>({...item,status:'ready',assetId:'output-a'}))),
    empty:()=>setShown(false),
  };
  return <main><header className="fixture-header"><span>Flume</span><p>Isolated component test / local sample media</p></header>
    <TakeReview shot={current} takes={shown?takes:[]} assets={assets} exports={exports}
      onInspect={async request=>{window.fixture.events.push({kind:'inspect',...request});return {inspectionId:`inspection-${request.takeId}`};}}
      onSelect={async request=>{window.fixture.events.push({kind:'select',...request});setCurrent(s=>({...s,selectedTakeId:request.takeId,selectionRevision:s.selectionRevision+1}));}}
      onExport={async request=>{window.fixture.events.push({kind:'export',...request});setExports(items=>[...items,{id:'export-a',projectId:current.projectId,shotId:current.id,takeId:current.selectedTakeId!,shotRevision:current.revision,selectionRevision:current.selectionRevision,status:'queued',assetId:null,stale:false}]);}}/>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
