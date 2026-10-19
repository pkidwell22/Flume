import assert from 'node:assert/strict';
import {test} from 'node:test';

test('entry configuration is explicitly opt-in, key-only is edit-only, scope and retention are separate',async()=>{
 const mod=await import('../src/local-configuration.ts').catch(()=>null);
 assert.equal(typeof mod?.readLocalRuntimeConfiguration,'function','a pure entry-point configuration parser is required');
 const read=mod!.readLocalRuntimeConfiguration;
 for(const env of [{},{OPENROUTER_API_KEY:'synthetic-entry-key'},{FLUME_PROVIDER_MODE:'edit-only',OPENROUTER_API_KEY:'synthetic-entry-key',FLUME_H3_RETENTION_DECISION:'allow-temporary-retention'}]){
  let config!:ReturnType<typeof read>;assert.doesNotThrow(()=>{config=read(env);},'edit-only and key-only launches must remain usable without provider configuration');assert.equal(config.discover,false);assert.equal(config.runtime.getApiKey,undefined);assert.equal(config.runtime.privacyPolicy,undefined);
 }
 assert.throws(()=>read({FLUME_PROVIDER_MODE:'openrouter',OPENROUTER_API_KEY:'synthetic-entry-key'}),/FLUME_OPENROUTER_SCOPE/);
 for(const value of ['', 'OPENROUTER', 'openrouter ', 'enabled'])assert.throws(()=>read({FLUME_PROVIDER_MODE:value}),/FLUME_PROVIDER_MODE/);
 for(const value of ['','openrouter/a\n',' other/account/v1','openrouter/account?secret=value'])assert.throws(()=>read({FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:value}),/FLUME_OPENROUTER_SCOPE/);
 for(const value of ['', 'true','allow','allow-temporary-retention '])assert.throws(()=>read({FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:'openrouter/fixture/v1',FLUME_H3_RETENTION_DECISION:value}),/FLUME_H3_RETENTION_DECISION/);
 const source={FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:'openrouter/fixture/v1',OPENROUTER_API_KEY:'synthetic-entry-key',FLUME_H3_RETENTION_DECISION:'allow-temporary-retention',FLUME_FFMPEG_PATH:'/owned tools/ffmpeg',FLUME_FFPROBE_PATH:'/owned tools/ffprobe'};
 const config=read(source);source.OPENROUTER_API_KEY='later-mutation';source.FLUME_H3_RETENTION_DECISION='keep-blocked';
 assert.equal(config.discover,true);assert.equal(config.runtime.scope,'openrouter/fixture/v1');assert.equal(config.runtime.getApiKey?.(),'synthetic-entry-key');
 assert.deepEqual(config.runtime.privacyPolicy,{h3RetentionDecision:'allow-temporary-retention'});
 assert.deepEqual(config.runtime.mediaTools,{ffmpegPath:'/owned tools/ffmpeg',ffprobePath:'/owned tools/ffprobe'});
 assert.equal(JSON.stringify(config).includes('synthetic-entry-key'),false);
 const missing=read({FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:'openrouter/fixture/v1'});
 assert.equal(missing.runtime.getApiKey?.(),undefined);assert.deepEqual(missing.runtime.privacyPolicy,{h3RetentionDecision:'keep-blocked'});
 for(const value of ['', 'relative','/bad\npath'])assert.throws(()=>read({FLUME_FFMPEG_PATH:value}),/FLUME_FFMPEG_PATH/);
});

test('prior-job verification settings are paired, exact and only active in explicit openrouter mode',async()=>{
 const mod=await import('../src/local-configuration.ts').catch(()=>null);
 assert.equal(typeof mod?.readLocalRuntimeConfiguration,'function');
 const read=mod!.readLocalRuntimeConfiguration;
 const base={FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:'openrouter/fixture/v1',OPENROUTER_API_KEY:'synthetic-entry-key'};
 const configured=read({...base,FLUME_OPENROUTER_VERIFIED_MODEL_ID:'alibaba/wan-2.7',FLUME_OPENROUTER_VERIFIED_JOB_ID:'fixture-wan-job'});
 assert.equal(configured.discover,true);
 assert.deepEqual(configured.runtime.verificationReference,{modelId:'alibaba/wan-2.7',jobId:'fixture-wan-job'});
 assert.deepEqual(read(base).runtime.verificationReference,undefined,'omission keeps the unknown route with no authenticated reads');
 for(const [field,value] of [
  ['FLUME_OPENROUTER_VERIFIED_MODEL_ID','alibaba/wan-2.7'],
  ['FLUME_OPENROUTER_VERIFIED_JOB_ID','fixture-wan-job'],
  ['FLUME_OPENROUTER_VERIFIED_MODEL_ID',''],
  ['FLUME_OPENROUTER_VERIFIED_JOB_ID',''],
 ] as const){
  const one={...base,[field]:value};
  assert.throws(()=>read(one),/FLUME_OPENROUTER_VERIFIED/,'both settings are required together');
 }
 for(const value of [' alibaba/wan-2.7','alibaba/wan-2.7 ','alibaba/wan 2.7','alibaba','','alibaba/wan-2.7\n'])
  assert.throws(()=>read({...base,FLUME_OPENROUTER_VERIFIED_MODEL_ID:value,FLUME_OPENROUTER_VERIFIED_JOB_ID:'fixture-wan-job'}),/FLUME_OPENROUTER_VERIFIED/);
 for(const value of [' fixture-wan-job','fixture wan job','fixture-wan-job\n','-fixture',''])
  assert.throws(()=>read({...base,FLUME_OPENROUTER_VERIFIED_MODEL_ID:'alibaba/wan-2.7',FLUME_OPENROUTER_VERIFIED_JOB_ID:value}),/FLUME_OPENROUTER_VERIFIED/);
 const editOnly=read({FLUME_PROVIDER_MODE:'edit-only',FLUME_OPENROUTER_VERIFIED_MODEL_ID:'alibaba/wan-2.7',FLUME_OPENROUTER_VERIFIED_JOB_ID:'fixture-wan-job'});
 assert.equal(editOnly.discover,false);
 assert.equal(editOnly.runtime.verificationReference,undefined,'edit-only never attaches provider verification');
 const source={...base,FLUME_OPENROUTER_VERIFIED_MODEL_ID:'alibaba/wan-2.7',FLUME_OPENROUTER_VERIFIED_JOB_ID:'fixture-wan-job'};
 const snapshot=read(source);source.FLUME_OPENROUTER_VERIFIED_JOB_ID='later-job';
 assert.deepEqual(snapshot.runtime.verificationReference,{modelId:'alibaba/wan-2.7',jobId:'fixture-wan-job'});
});
