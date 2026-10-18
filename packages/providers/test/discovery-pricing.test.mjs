import assert from 'node:assert/strict';
import test from 'node:test';
import {createOpenRouterVideoProvider} from '../src/index.ts';
import {fixture,jsonResponse,options} from './helpers.mjs';

const rawModel={id:'minimax/hailuo-3',name:'Synthetic H3',supported_durations:[5,6],supported_resolutions:['2K'],supported_aspect_ratios:['16:9'],supported_frame_images:['first_frame','last_frame'],seed:false,generate_audio:false};
test('discovery retains complete exact-model pricing_skus from the same observation without granting entitlement',async t=>{
 const skus={duration_seconds:'0.17',reference_images:'0.021',unrecognized_component:{tiers:[1,2]}};
 const f=await fixture(t,(_req,res)=>jsonResponse(res,200,{data:[{...rawModel,pricing_skus:skus},{...rawModel,id:'another/model',pricing_skus:{duration_seconds:'9'}},{...rawModel,id:'missing/pricing'}]}));
 const result=await createOpenRouterVideoProvider(options(f)).discoverModels();
 assert.equal(result.status,'ok');
 assert.deepEqual(result.pricing,[
  {provider:'openrouter',modelId:'minimax/hailuo-3',currency:'USD',pricingSkus:skus},
  {provider:'openrouter',modelId:'another/model',currency:'USD',pricingSkus:{duration_seconds:'9'}},
  {provider:'openrouter',modelId:'missing/pricing',currency:'USD',pricingSkus:null},
 ]);
 assert.ok(result.capabilities.every(c=>c.availability==='unknown'));
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'GET');assert.equal(f.requests[0].headers.authorization,undefined);
});
