// Mutate isolated, ignored copies only. Never patch the live proven core.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync,mkdirSync,readdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync } from 'node:fs';
import path from 'node:path';
const root=path.resolve('.');
const mutations=[
  ['identity','service.ts','token_hash=$1 AND project_id=$2 AND expires_at','token_hash=$1 AND $2::uuid IS NOT NULL AND expires_at','service.test.ts','cross-project','Missing expected rejection'],
  ['revision','service.ts','if (cmd.revision!==draft.revision)','if (false)','service.test.ts','both callers','The input did not match the regular expression /REVISION_CONFLICT/'],
  ['approval','service.ts','if(!actor.can_review)','if(false)','service.test.ts','first-look','Missing expected rejection'],
  ['inspection-owner','service.ts','WHERE id=$1 AND actor_id=$2 AND shot_id=$3 AND artifact=$4','WHERE id=$1 AND $2::uuid IS NOT NULL AND shot_id=$3 AND artifact=$4','recovery.test.ts','SIGKILL at bytes','Missing expected rejection'],
  ['stale-export','service.ts',"await client.query('UPDATE parity.exports SET stale=true WHERE shot_id=$1',[shotId]);",'/* mutation: stale invalidation removed */','export.test.ts','edit and selection','false !== true'],
  ['frozen-export','schema.sql',"THEN RAISE EXCEPTION 'IMMUTABLE_EXPORT'; END IF;",'THEN RETURN NEW; END IF;','export.test.ts','edit and selection','Missing expected rejection'],
  ['await-edit','service.ts',"if (cmd.type==='edit') return await transaction", "if (cmd.type==='edit') return transaction",'locking.test.ts','overlapping human/agent edit','shot advisory lock must remain held until COMMIT'],
  ['await-approve','service.ts','const reviewId=randomUUID(),fingerprint=hash(frozen);\n        return await transaction','const reviewId=randomUUID(),fingerprint=hash(frozen);\n        return transaction','locking.test.ts','approve retains','adapter advisory lock must remain held'],
  ['await-selection','service.ts','await inspectVideo(media.path,inspection.sha256);\n        return await transaction','await inspectVideo(media.path,inspection.sha256);\n        return transaction','locking.test.ts','overlapping human/agent selection','shot advisory lock must remain held until COMMIT'],
  ['await-accept','service.ts','return await accept(e,','return accept(e,','locking.test.ts','submit retains','adapter advisory lock must remain held'],
  ['edit-cas','service.ts','WHERE id=$1 AND revision=$3','WHERE id=$1 AND $3::int IS NOT NULL','locking.test.ts','edit compare-and-set','Missing expected rejection'],
  ['selection-cas','service.ts','WHERE shot_id=$1 AND selection_revision=$3','WHERE shot_id=$1 AND $3::int IS NOT NULL','locking.test.ts','selection compare-and-set','Missing expected rejection'],
  ['receipt-first','service.ts','if(accepted) {','if(false) {','service.test.ts','accepted submit replay','Error: REVISION_CONFLICT'],
  ['receipt-intent','service.ts',"if(cmd.revision!==accepted.request.draftRevision || accepted.request.shotId!==shotId)",'if(false)','service.test.ts','accepted submit replay','Missing expected rejection'],
  ['coalesced-start','http.ts','if(pending)return pending;','if(false)return pending;','dispatch.test.ts','concurrent identical','duplicate dispatch must not record a false interruption'],
  ['failed-start','http.ts','starts.delete(id);','/* mutation: pending failure retained */','dispatch.test.ts','failed queue read','failed start must not poison future retries'],
  ['closing-start','http.ts','closing=true;server.closeAllConnections();','server.closeAllConnections();','dispatch.test.ts','closing HTTP','shutdown must not launch a worker'],
  ['save-buffer','ui/ui.js','inspections.clear();await refresh(false);message($(\'prompt\').value===saved.prompt','inspections.clear();await refresh();message($(\'prompt\').value===saved.prompt','ui.test.ts','base revision: typing','newer editor input must survive save completion'],
  ['save-base','ui/ui.js','await refresh(false);message($(\'prompt\').value===saved.prompt','await refresh(false);editorRevision=state.revision;message($(\'prompt\').value===saved.prompt','ui.test.ts','base revision: newer-server-revision','editor base is the saved response, not a later GET revision'],
  ['unknown-write','ui/ui.js','The result may be unknown.','Saved state was not overwritten.','ui.test.ts','base revision: lost-response','a lost response cannot imply the write did not commit'],
  ['acquisition-cleanup','demo.ts',"  const handle=await open(file,'wx',0o600);\n  // Only a successfully acquired file belongs to this process's cleanup.\n  cleanup.push(()=>rm(file,{force:true}));", "  cleanup.push(()=>rm(file,{force:true}));\n  const handle=await open(file,'wx',0o600);",'demo.test.ts','startup collision at demo.json','pre-existing sentinel must survive exclusive-create failure'],
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
