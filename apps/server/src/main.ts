import pg from 'pg';
import { migrate } from '@flume/database';
import { createCommandService } from './service.ts';
import { buildServer } from './http.ts';
import { createRuntime } from './runtime.ts';
import { readLocalRuntimeConfiguration } from './local-configuration.ts';
import {createChatProviderStack,createContainerChat} from './container-chat.ts';
import {createChatVisualResolver} from './chat-visual.ts';
import {resolveMediaToolPaths} from './media-bridge.ts';
import {composeAuthoringRuntime} from './authoring-composition.ts';

// The root launcher is the ONLY PostgreSQL owner. Standalone server requires its explicit contract.
const databaseUrl=process.env.DATABASE_URL;
const mediaRoot=process.env.FLUME_STORAGE_ROOT;
if(!databaseUrl||!mediaRoot||!process.env.FLUME_DATA_DIR)throw new Error('Use npm run dev at the workspace root (DATABASE_URL, FLUME_STORAGE_ROOT and FLUME_DATA_DIR are required).');
const database=new URL(databaseUrl);
if(!['postgres:','postgresql:'].includes(database.protocol)||database.hostname!=='127.0.0.1'||database.pathname!=='/flume')throw new Error('The local product requires the launcher-owned loopback flume database.');
const port=Number(process.env.FLUME_PORT??4311);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('FLUME_PORT must be an unprivileged TCP port');
const origin=`http://127.0.0.1:${port}`;
const ui=process.env.FLUME_ALLOWED_ORIGIN??'http://127.0.0.1:4310';
const allowedOrigins=[origin,ui];
for(const value of allowedOrigins){const u=new URL(value);if(u.origin!==value||u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname))throw new Error('FLUME_ALLOWED_ORIGIN must be an exact loopback HTTP origin');}
const configuration=readLocalRuntimeConfiguration(process.env);
const pool=new pg.Pool({connectionString:databaseUrl,max:12});
let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined;
let app:Awaited<ReturnType<typeof buildServer>>|undefined;
let closing:Promise<void>|undefined;
const shutdown=()=>closing??=(async()=>{await app?.close();await runtime?.close();await pool.end();})();
try{
 await migrate(pool);
 runtime=await createRuntime({pool,mediaRoot,...configuration.runtime});
 if(configuration.discover)await runtime.discover();
 const service=createCommandService({pool,...runtime.serviceOptions});
 // Frame authoring is wired only from explicit configuration; the default image route stays
 // blocked and exposes no models, no estimates and no dispatch path. The composition seam is shared
 // with the container entry point (./authoring-composition.ts) so the two cannot drift apart.
 const authoring=await composeAuthoringRuntime({
  sql:pool,media:runtime.serviceOptions.media,commands:service,
  stagingRoot:configuration.authoring.stagingRoot,image:configuration.authoring.image,
  // Storyboard proposals need an explicit planner model and a server credential. With neither
  // block, the route and capability stay explicitly blocked; a configured planner is instantiated
  // over the same registered chat transports and credential accessors as project chat, and still
  // cannot create shots or generate media.
  planner:configuration.storyboard.mode==='chat'
   ? {configuration:configuration.storyboard,chat:()=>createChatProviderStack(process.env,env=>env.OPENROUTER_API_KEY??null)}
   : null,
 });
 const chat=process.env.FLUME_CHAT_STORE_ROOT?await(async()=>{const mediaTools=resolveMediaToolPaths(configuration.runtime.mediaTools),resolveVisual=createChatVisualResolver({readMedia:service.readMedia,ffmpegPath:mediaTools.ffmpegPath,ffprobePath:mediaTools.ffprobePath,scratchRoot:process.env.FLUME_CHAT_SCRATCH_ROOT});return createContainerChat(process.env,service.getWorkspace,service.command,resolveVisual,env=>env.OPENROUTER_API_KEY??null);})():undefined;
 app=await buildServer({service,authoring,...(chat?{chat}:{}),security:{mode:process.env.FLUME_LOCAL_OPERATOR==='1'?'local-operator':'protected',allowedHosts:[`127.0.0.1:${port}`,`localhost:${port}`,new URL(ui).host],allowedOrigins}});
 await app.listen({host:'127.0.0.1',port});
 console.log(`Flume API ${origin}; owned media and durable worker attached; project chat ${chat?'store attached':'disabled'}. ${configuration.discover?'OpenRouter configured; catalog discovery grants no entitlement. Review blockers and separate operator approval still apply.':'Edit-only; no generation credentials loaded or catalog discovery requested.'} ${configuration.authoring.image.mode==='openrouter'?'Image authoring configured; every submit needs an operator-approved cap above the server estimate.':'Image authoring blocked; no image models or quotes are exposed.'} ${authoring.storyboard?'Storyboard proposals use the configured planner model.':'Storyboard proposals stay blocked until a planner model is configured.'}`);
 process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
}catch(error){await shutdown();throw error;}
