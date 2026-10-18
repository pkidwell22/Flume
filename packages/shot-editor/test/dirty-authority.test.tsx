import './setup.ts';
import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {ShotEditor} from '../src/index.ts';
import {shot,assets,capabilities} from './fixtures.ts';
afterEach(cleanup);

test('canonical edits publish dirty synchronously before the parent change handler',()=>{
 const signals:boolean[]=[];const atParent:boolean[]=[];
 render(<div onChange={()=>atParent.push(signals.at(-1)??false)}><ShotEditor shot={shot} assets={assets} capabilities={capabilities} onDirtyChange={dirty=>signals.push(dirty)} onSave={async()=>({revision:4})} onUpload={async()=>assets[0]!} onPrepare={async()=>{}}/></div>);
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'First edit'}});
 assert.deepEqual(atParent,[true], 'the parent must see dirty in the same synthetic dispatch, not a later effect');
 const count=signals.length;
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'Second edit'}});
 assert.ok(signals.length>count,'an already-dirty edit must still advance the save fence');
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:shot.prompt}});
 assert.equal(atParent.at(-1),false,'reverting to the saved draft clears the same authority synchronously');
});

test('button-driven binding changes publish dirty before parent click handlers',()=>{
 const signals:boolean[]=[];const atParent:boolean[]=[];
 render(<div onClick={()=>atParent.push(signals.at(-1)??false)}><ShotEditor shot={{...shot,bindings:{...shot.bindings,firstFrameAssetId:assets[0]!.id}}} assets={assets} capabilities={capabilities} onDirtyChange={dirty=>signals.push(dirty)} onSave={async()=>({revision:4})} onUpload={async()=>assets[0]!} onPrepare={async()=>{}}/></div>);
 fireEvent.click(screen.getByRole('button',{name:'Clear start frame'}));
 assert.deepEqual(atParent,[true], 'custom widgets do not emit native input; the canonical update must fence immediately');
});
