import './setup.tsx';
import {afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {ActivityPanel,GenerationReview} from '../src/index.ts';
afterEach(cleanup);
const review={id:'r',projectId:'p',shotId:'s',shotRevision:1,requestHash:'a'.repeat(64),prompt:'test',controls:{modelId:'m',durationSeconds:5,resolution:'2K',aspectRatio:'16:9',generateAudio:false},bindings:{firstFrameAssetId:null,lastFrameAssetId:null},estimatedCostUsd:null,blockers:[],approved:false};
test('unknown price holds approval rather than inventing a spend cap or silently removing it',()=>{
 let calls=0;render(<GenerationReview review={review} assets={[]} onApprove={()=>{calls++;}} onSubmit={()=>{calls++;}} onDismiss={()=>{}}/>);
 const input=screen.queryByRole('textbox',{name:'Spending limit (USD)'});if(input)fireEvent.change(input,{target:{value:'9.00'}});
 assert.equal((screen.getByRole('button',{name:'Approve this generation'}) as HTMLButtonElement).disabled,true);
 assert.ok(screen.getByText(/approval is on hold/i));assert.equal(calls,0);
});
test('running without receipt describes unconfirmed submission, not proven provider execution',()=>{
 const attempt={id:'a',projectId:'p',shotId:'s',shotRevision:1,status:'running' as const,providerJobId:null,errorCode:null,message:null};
 const view=render(<ActivityPanel attempts={[attempt]} assets={[]} onResume={()=>{}}/>);
 assert.ok(screen.getByText('Confirming submission'));
 view.rerender(<ActivityPanel attempts={[{...attempt,providerJobId:'job'}]} assets={[]} onResume={()=>{}}/>);
 assert.ok(screen.getByText('Awaiting result'));
});
test('amounts use the server decimal precision and never promise a provider-enforced cap',()=>{
 render(<GenerationReview review={{...review,estimatedCostUsd:'0.10'}} assets={[]} onApprove={()=>{}} onSubmit={()=>{}} onDismiss={()=>{}}/>);
 for(const value of ['1000000000','0.0000001']){fireEvent.change(screen.getByRole('textbox'),{target:{value}});assert.equal((screen.getByRole('button',{name:'Approve this generation'}) as HTMLButtonElement).disabled,true);}
 assert.ok(screen.getByText(/not a provider-enforced billing cap/i));
});
