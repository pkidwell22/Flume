import pg from 'pg';
import { migrate } from '@flume/database';
import { createCommandService } from './service.ts';
import { buildServer } from './http.ts';
import { createRuntime } from './runtime.ts';
import { readLocalRuntimeConfiguration } from './local-configuration.ts';
import { createChatService, createOpenRouterChatProvider } from './chat-service.ts';
import { createFileChatStore } from './chat-store.ts';

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
 const chatRoot=process.env.FLUME_CHAT_STORE_ROOT;
 const chat=chatRoot?createChatService({store:await createFileChatStore({root:chatRoot}),provider:createOpenRouterChatProvider({getCredential:async()=>process.env.OPENROUTER_API_KEY?.trim()||null}),getWorkspace:service.getWorkspace,command:service.command}):undefined;
 app=await buildServer({service,...(chat?{chat}:{}),security:{mode:process.env.FLUME_LOCAL_OPERATOR==='1'?'local-operator':'protected',allowedHosts:[`127.0.0.1:${port}`,`localhost:${port}`,new URL(ui).host],allowedOrigins}});
 await app.listen({host:'127.0.0.1',port});
 console.log(`Flume API ${origin}; owned media and durable worker attached; project chat ${chat?'store attached':'disabled'}. ${configuration.discover?'OpenRouter configured; catalog discovery grants no entitlement. Review blockers and separate operator approval still apply.':'Edit-only; no generation credentials loaded or catalog discovery requested.'}`);
 process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
}catch(error){await shutdown();throw error;}
