import './setup.ts';
import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {ShotEditor} from '../src/index.ts';
import {shot,assets,capabilities} from './fixtures.ts';
afterEach(cleanup);
test('a saved provider-blocked shot can open its exact read-only review without approving or submitting',async()=>{
 let reviewed=0;
 render(<ShotEditor shot={shot} assets={assets} capabilities={[{...capabilities[0]!,availability:'blocked',blocker:'ZDR policy blocks generation'}]} onSave={async()=>({revision:4})} onUpload={async()=>assets[0]!} onPrepare={async()=>{reviewed++;}}/>);
 assert.equal((screen.getByRole('button',{name:'Review generation'}) as HTMLButtonElement).disabled,false);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Review generation'})));assert.equal(reviewed,1);
});
