// Mutate isolated, ignored copies only. Never patch the live proven core.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync,mkdirSync,readdirSync,readFileSync,writeFileSync,symlinkSync,rmSync,existsSync } from 'node:fs';
import path from 'node:path';
const root=path.resolve('.');
const mutations=[
  ['identity','service.ts','token_hash=$1 AND project_id=$2 AND (expires_at','token_hash=$1 AND $2::uuid IS NOT NULL AND (expires_at','service.test.ts','cross-project','Missing expected rejection'],
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
  ['coalesced-start','http.ts','const pending=starts.get(id);','const pending=undefined;','dispatch.test.ts','concurrent identical','duplicate dispatch must not record a false interruption'],
  ['mixed-recovery','http.ts','if(pending&&!recovery)return pending;','if(pending)return pending;','dispatch.test.ts','mixed recovery','explicit recovery must complete the same job without another command'],
  ['recovery-generation','http.ts','if((generations.get(id)??0)!==recovery.generation)return;','/* mutation: newer activation discarded */','dispatch.test.ts','newly valid worker: recover$','overlapping recovery must not replace a newly valid worker'],
  ['recovery-response-window','http.ts','recoveries.get(id)??{generation:generations.get(id)??0,callers:0}','{generation:generations.get(id)??0,callers:0}','dispatch.test.ts','newly valid worker: recover-response','overlapping recovery must not replace a newly valid worker'],
  ['recovery-stop-order','http.ts','await workers.get(id)?.stop();await recovery.reactivate();','await recovery.reactivate();await workers.get(id)?.stop();','dispatch.test.ts','stops the previously owned worker','old worker must exit before queue reactivation'],
  ['recovery-uuid-key','http.ts','const id=command.attemptId.toLowerCase();','const id=command.attemptId;','uuid-key.test.ts','validated uppercase UUID','valid UUID case variants must dispatch recovery of the original job'],
  ['recovery-uuid-group','http.ts','group.callers++;recoveries.set(id,group);','group.callers++;recoveries.set(command.attemptId,group);','uuid-key.test.ts','canonical caller generation: command-response','mixed-case overlap must not replace a newly valid worker'],
  ['recovery-uuid-repair','http.ts','let result;',"if(command?.type==='recover'&&typeof command.attemptId==='string')command.attemptId=command.attemptId.trim();\n        let result;",'uuid-key.test.ts','malformed recovery UUIDs','malformed UUID must reject without repairing caller input'],
  ['failed-start','http.ts','starts.delete(id);','/* mutation: pending failure retained */','dispatch.test.ts','failed queue read','failed start must not poison future retries'],
  ['closing-start','http.ts','closing=true;server.closeAllConnections();','server.closeAllConnections();','dispatch.test.ts','closing HTTP','shutdown must not launch a worker'],
  ['save-buffer','ui/ui.js','inspections.clear();await refresh(false);message($(\'prompt\').value===saved.prompt','inspections.clear();await refresh();message($(\'prompt\').value===saved.prompt','ui.test.ts','base revision: typing','newer editor input must survive save completion'],
  ['save-post-buffer','ui/ui.js','editorRevision=saved.revision;','$(\'prompt\').value=saved.prompt;editorRevision=saved.revision;','ui.test.ts','base revision: typing','POST success must preserve text typed before its response'],
  ['save-base','ui/ui.js','await refresh(false);message($(\'prompt\').value===saved.prompt','await refresh(false);editorRevision=state.revision;message($(\'prompt\').value===saved.prompt','ui.test.ts','base revision: newer-server-revision','editor base is the saved response, not a later GET revision'],
  ['unknown-write','ui/ui.js','The result may be unknown.','Saved state was not overwritten.','ui.test.ts','base revision: lost-response','a lost response cannot imply the write did not commit'],
  ['acquisition-cleanup','demo.ts',"  const handle=await open(file,'wx',0o600);\n  // Only a successfully acquired file belongs to this process's cleanup.\n  cleanup.push(()=>rm(file,{force:true}));", "  cleanup.push(()=>rm(file,{force:true}));\n  const handle=await open(file,'wx',0o600);",'demo.test.ts','startup collision at demo.json','pre-existing sentinel must survive exclusive-create failure'],
  ['demo-opt-in','demo.ts',",'trusted-local-fixture-review');",');','demo.test.ts','owned demo publishes','default demo must not deliver a key-entry form'],
  ['demo-auto-entry','ui/ui.js',"refresh().catch(()=>message(","Promise.resolve().catch(()=>message(",'demo.test.ts','owned demo publishes','opening the default demo must automatically reach review'],
  ['local-session-expiry','http.ts','localReview?service.localFixtureReviewer','localReview?service.credentials.human','demo.test.ts','owned demo publishes','expired fixture session must not require manual reentry'],
  ['protected-default','http.ts',"mode==='trusted-local-fixture-review'",'true','local-review.test.ts','protected default','default API must reject unauthenticated reads'],
  ['local-bearer-upgrade','http.ts','const token=bearer??(','const token=(localReview?service.localFixtureReviewer:bearer)??(','local-review.test.ts','never upgrades bearer','explicit agent must stay agent'],
  ['local-agent-approval','service.ts','if(!actor.can_review)','if(false)','local-review.test.ts','never upgrades bearer','explicit agent must not approve'],
  ['local-malformed-auth','http.ts',"if(req.headers.authorization!==undefined&&(!bearer||req.headersDistinct.authorization?.length!==1)) throw new Error('AUTHORIZATION');",'/* mutation: malformed credentials fall through */','local-review.test.ts','rejects malformed or invalid credentials','malformed authorization must not become reviewer'],
  ['local-duplicate-auth','http.ts','||req.headersDistinct.authorization?.length!==1','','local-review.test.ts','rejects malformed or invalid credentials','duplicate authorization headers must not resolve a principal'],
  ['local-cookie-upgrade','http.ts','req.headers.cookie!==undefined?cookie:','cookie?cookie:','local-review.test.ts','rejects malformed or invalid credentials','supplied invalid cookie must not become reviewer'],
  ['protected-session-expiry','service.ts','(expires_at>clock_timestamp() OR $3)','($3::boolean OR true)','local-review.test.ts','local expiry continuity','supplied expired bearer must stay expired'],
  ['legacy-file-cleanup','demo.ts',"await writeOwnedFile('output/agent-session.txt',service.credentials.agent);","await writeOwnedFile('output/agent-session.txt',service.credentials.agent);cleanup.push(()=>rm('output/human-session.txt',{force:true}));",'demo.test.ts','startup collision at human-session.txt','pre-existing sentinel must survive exclusive-create failure'],
  ['local-host','http.ts','if(req.headers.host!==new URL(origin).host)','if(false)','local-review.test.ts','retains Host Origin','foreign Host must fail'],
  ['local-origin','http.ts','if(req.headers.origin&&req.headers.origin!==origin)','if(false)','local-review.test.ts','retains Host Origin','cross-origin reads must fail'],
  ['local-post-origin','http.ts',"if(req.method==='POST'&&!bearer&&req.headers.origin!==origin)",'if(false)','local-review.test.ts','retains Host Origin','credential-free POST requires same origin'],
  ['local-spend','service.ts',"['transfer','spend','authorize'].includes(String(raw.type))",'false','local-review.test.ts','retains Host Origin','local review must not confer transfer or spend'],
  ['local-provider-route','provider.ts',"z.literal('fixture/video-v1')",'z.string()','local-review.test.ts','retains Host Origin','provider must reject non-fixture routes'],
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
