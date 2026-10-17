import assert from 'node:assert/strict';
import { mkdir,open,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { createOwnedCluster } from '../01-approved-attempt/scripts/disposable-postgres.mjs';
import { openExperiment } from '../01-approved-attempt/dist/src/database.js';
import { createService } from './service.ts';
import { startProvider } from './provider.ts';
import { startHttp } from './http.ts';

const cleanup:(()=>Promise<unknown>)[]=[];
async function writeOwnedFile(file:string,contents:string) {
  const handle=await open(file,'wx',0o600);
  // Only a successfully acquired file belongs to this process's cleanup.
  cleanup.push(()=>rm(file,{force:true}));
  try {await handle.writeFile(contents);} finally {await handle.close();}
}
let stop!:()=>void, interrupted=false;
const stopped=new Promise<void>(resolve=>{stop=resolve;});
const onSignal=()=>{interrupted=true;stop();};
// Install before initdb, not after the first acquired resource.
process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
try {
  await mkdir('output',{recursive:true});
  const lock=await open('output/demo.lock','wx',0o600);
  cleanup.push(()=>rm('output/demo.lock'));
  try {await lock.writeFile(String(process.pid));} finally {await lock.close();}
  const cluster=await createOwnedCluster();cleanup.push(()=>cluster.cleanup());
  if(interrupted) throw new Error('INTERRUPTED');
  Object.assign(process.env,{SPIKE_DATABASE:cluster.database,SPIKE_DATA_DIRECTORY:cluster.dataDirectory,SPIKE_SOCKET:cluster.socketDirectory});
  const e=await openExperiment();cleanup.push(()=>e.close());
  const catalog=JSON.parse(await readFile('output/catalog.json','utf8'));
  const service=await createService(e,catalog,cluster.root);
  const provider=await startProvider(catalog);cleanup.push(()=>provider.close());
  const api=await startHttp(service,{origin:provider.origin,storage:cluster.root,lookup:true,replaySafe:true,replaySeconds:60,adapter:'fixture-1'},'trusted-local-fixture-review');
  cleanup.push(()=>api.close());
  await writeOwnedFile('output/agent-session.txt',service.credentials.agent);
  if(interrupted) throw new Error('INTERRUPTED');
  assert.equal((await fetch(api.origin+'/health')).status,200);
  const pgPid=Number((await readFile(path.join(cluster.dataDirectory,'postmaster.pid'),'utf8')).split('\n')[0]);
  const ready={origin:api.origin,pid:process.pid,pgPid,root:cluster.root};
  await writeOwnedFile('output/demo.json',JSON.stringify(ready,null,2));
  console.log(`READY ${api.origin} — trusted local fixture review; no sign-in or human identity proof. Stop with Ctrl-C.`);
  process.send?.(ready);
  await stopped;
} catch(error) {
  if(!interrupted){console.error((error as Error).message);process.exitCode=1;}
} finally {
  const errors=[];
  for(const close of cleanup.reverse()){try{await close();}catch(error){errors.push(error);}}
  process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);
  if(errors.length){console.error('CLEANUP_FAILED',errors.length);process.exitCode=1;}
  process.disconnect?.();
}
