import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {readLocalRuntimeConfiguration} from '../src/local-configuration.ts';

test('actual main entry invokes configuration and read-only discovery before serving, with secret-free logs',async()=>{
 const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 for(const configured of [true,false]){
  const events:string[]=[],logs:string[]=[];let options:any,authoringInput:any;
  const unexpectedChat = () => { throw new Error('Chat must not initialize without an explicit store root'); };
  const modules:Record<string,unknown>={
   './container-chat.ts':{createContainerChat:unexpectedChat},
   './chat-visual.ts':{createChatVisualResolver:unexpectedChat},
   './media-bridge.ts':{resolveMediaToolPaths:unexpectedChat},
   pg:{Pool:class {async end(){events.push('pool.close');}}},
   '@flume/database':{async migrate(){events.push('migrate');}},
   './runtime.ts':{async createRuntime(input:any){events.push('runtime');options=input;return {serviceOptions:{},async discover(){events.push('discover');},async close(){events.push('runtime.close');}};}},
   './service.ts':{createCommandService(){events.push('service');return {};}},
   './http.ts':{async buildServer(){events.push('http');return {async listen(){events.push('listen');},async close(){events.push('app.close');}};}},
   './local-configuration.ts':{readLocalRuntimeConfiguration},
   './authoring-composition.ts':{async composeAuthoringRuntime(input:any){events.push('authoring.compose');authoringInput=input;return {capabilities:async()=>({imageModels:[],storyboard:{available:false,blocker:'fixture blocker'}}),storyboard:null,continueShot:null};}},
  };
  const env={DATABASE_URL:'postgresql://127.0.0.1/flume',FLUME_STORAGE_ROOT:'/synthetic-not-opened/media',FLUME_DATA_DIR:'/synthetic-not-opened',OPENROUTER_API_KEY:'synthetic-entry-key',
   ...(configured?{FLUME_PROVIDER_MODE:'openrouter',FLUME_OPENROUTER_SCOPE:'openrouter/synthetic-account/v1',FLUME_H3_RETENTION_DECISION:'allow-temporary-retention',FLUME_FFMPEG_PATH:'/synthetic/tools/ffmpeg'}:{})};
  await runInNewContext(`(async()=>{${code}\n})()`,{exports:{},require:(name:string)=>{assert.ok(name in modules,name);return modules[name];},URL,process:{env,once(){}},console:{log:(text:string)=>logs.push(text)}});
  assert.equal(events.filter(e=>e==='discover').length,configured?1:0);
  assert.equal(typeof options.getApiKey,configured?'function':'undefined');
  if(configured){
   assert.equal(options.getApiKey(),'synthetic-entry-key');assert.equal(options.scope,'openrouter/synthetic-account/v1');
   assert.equal(options.privacyPolicy.h3RetentionDecision,'allow-temporary-retention');assert.equal(options.mediaTools.ffmpegPath,'/synthetic/tools/ffmpeg');
   assert.ok(events.indexOf('discover')<events.indexOf('listen'));
   assert.match(logs.join('\n'),/entitlement/i);assert.doesNotMatch(logs.join('\n'),/no generation credentials loaded/);
  }else assert.match(logs.join('\n'),/edit-only/i);
  assert.equal(logs.join('\n').includes('synthetic-entry-key'),false);
  // Frame authoring is composed from explicit configuration before the API starts serving, through
  // the same shared seam the container entry point uses.
  assert.ok(events.includes('authoring.compose'));
  assert.ok(events.indexOf('authoring.compose')<events.indexOf('listen'));
  assert.equal(authoringInput.stagingRoot,'/synthetic-not-opened/frame-staging');
  assert.equal(authoringInput.image.mode,'blocked');
  assert.equal(authoringInput.planner,null);
  assert.match(logs.join('\n'),/Image authoring (configured|blocked)/);
 }
});
