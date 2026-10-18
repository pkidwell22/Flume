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
