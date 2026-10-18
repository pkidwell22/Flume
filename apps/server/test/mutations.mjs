import assert from 'node:assert/strict';
import { cp,mkdtemp,mkdir,symlink,readFile,writeFile,rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
const source=fileURLToPath(new URL('..',import.meta.url));
const deps=path.dirname(path.dirname(fileURLToPath(import.meta.resolve('pg/package.json'))));
const loader=fileURLToPath(import.meta.resolve('tsx'));
const root=await mkdtemp(path.join(tmpdir(),'fl-mutation-'));
try{
 await mkdir(path.join(root,'apps'),{recursive:true});await mkdir(path.join(root,'packages'));
 await symlink(deps,path.join(root,'node_modules'),'dir');
 await symlink(path.resolve(source,'../../packages/database'),path.join(root,'packages/database'),'dir');
 const server=path.join(root,'apps/server');await mkdir(server);
 await cp(path.join(source,'src'),path.join(server,'src'),{recursive:true});
 await cp(path.join(source,'test'),path.join(server,'test'),{recursive:true});
 await cp(path.join(source,'package.json'),path.join(server,'package.json'));
 const mutations=[
  {file:'generation.ts',old:'expires_at>clock_timestamp()',replacement:'expires_at>now()',pattern:'expired approval'},
  {file:'worker-store.ts',old:'job.owner_id!==lease.ownerId||a.owner_id!==lease.ownerId||job.fence!==lease.jobFence||a.fence!==lease.fence||',replacement:'',pattern:'dispatch is fenced'},
 ];
 for(const m of mutations){
  const target=path.join(server,'src',m.file),original=await readFile(target,'utf8');assert(original.includes(m.old));
  await writeFile(target,original.replace(m.old,m.replacement));
  const run=spawnSync(process.execPath,['--import',loader,'--test','--test-concurrency=1',`--test-name-pattern=${m.pattern}`,'test/guards.test.ts'],{cwd:server,encoding:'utf8',env:{...process.env,LC_ALL:'C'}});
  await writeFile(target,original);
  assert.equal(run.status,1,`${m.file} mutation must be rejected\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout+run.stderr,/Missing expected rejection/);
  console.log(`Rejected negative control: ${m.file} / ${m.pattern}`);
 }
}finally{await rm(root,{recursive:true,force:true});}
