// Mutate isolated, ignored copies only. Never patch the live proven core.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync,mkdirSync,readdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync } from 'node:fs';
import path from 'node:path';
const root=path.resolve('.');
const mutations=[
  ['identity','service.ts','token_hash=$1 AND project_id=$2 AND expires_at','token_hash=$1 AND $2::uuid IS NOT NULL AND expires_at','service.test.ts','cross-project','Missing expected rejection'],
  ['revision','service.ts','if (cmd.revision!==draft.revision)','if (false)','service.test.ts','both callers','Missing expected rejection'],
  ['approval','service.ts','if(!actor.can_review)','if(false)','service.test.ts','first-look','Missing expected rejection'],
  ['inspection-owner','service.ts','WHERE id=$1 AND actor_id=$2 AND shot_id=$3 AND artifact=$4','WHERE id=$1 AND $2::uuid IS NOT NULL AND shot_id=$3 AND artifact=$4','recovery.test.ts','SIGKILL at bytes','Missing expected rejection'],
  ['stale-export','service.ts',"await client.query('UPDATE parity.exports SET stale=true WHERE shot_id=$1',[shotId]);",'/* mutation: stale invalidation removed */','export.test.ts','edit and selection','false !== true'],
  ['frozen-export','schema.sql',"THEN RAISE EXCEPTION 'IMMUTABLE_EXPORT'; END IF;",'THEN RETURN NEW; END IF;','export.test.ts','edit and selection','Missing expected rejection'],
];
const results=[];
for(const [name,file,from,to,test,pattern,expected] of mutations) {
  const directory=path.join(root,'output/mutations',name);
  rmSync(directory,{recursive:true,force:true});mkdirSync(directory,{recursive:true});
  const target=path.join(directory,'04-caller-parity');
  mkdirSync(target,{recursive:true});
  for(const entry of readdirSync(root).filter(p=>!['node_modules','output'].includes(p))) cpSync(path.join(root,entry),path.join(target,entry),{recursive:true});
  symlinkSync(path.join(root,'node_modules'),path.join(target,'node_modules'),'dir');
  symlinkSync(path.resolve(root,'../01-approved-attempt'),path.join(directory,'01-approved-attempt'),'dir');
  symlinkSync(path.resolve(root,'../02-frame-provenance'),path.join(directory,'02-frame-provenance'),'dir');
  mkdirSync(path.join(target,'output'));cpSync(path.join(root,'output/catalog.json'),path.join(target,'output/catalog.json'));
  const filename=path.join(target,file),source=readFileSync(filename,'utf8');assert(source.includes(from),`mutation missing: ${name}`);
  writeFileSync(filename,source.replaceAll(from,to));
  const result=spawnSync(process.execPath,['--test',`--test-name-pattern=${pattern}`,`test/${test}`],{cwd:target,encoding:'utf8',timeout:60000});
  const log=result.stdout+result.stderr;writeFileSync(path.join(directory,'result.log'),log);
  assert.equal(result.status,1,`${name} did not fail as expected`);assert(log.includes(expected),`${name}: unexpected failure: ${log}`);
  const identities=[...log.matchAll(/IDENTITY verified: (\{[^\n]+\})/g)];assert.equal(identities.length,1);
  for(const match of identities) {
    const identity=JSON.parse(match[1]);assert(!existsSync(path.dirname(identity.dataDirectory)),'owned cluster leaked');
  }
  results.push({mutation:name,rejected:true,expectedAssertion:expected});
  console.log(`REJECTED ${name}: ${expected}`);
}
writeFileSync('output/mutations/results.json',JSON.stringify(results,null,2));
assert.equal(results.length,mutations.length);
