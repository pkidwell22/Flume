import assert from 'node:assert/strict';
import test from 'node:test';
import { setup } from './support.ts';
import { hash } from '../../01-approved-attempt/dist/src/contracts.js';

test('first-look artifact review binds exact plan; only server mints and reserves authority',async t=>{
  const {service:s,fresh,catalog}=await setup(t);
  await assert.rejects(s.command(s.credentials.agent,{type:'submit',revision:1,commandId:crypto.randomUUID()}),/REVIEW_REQUIRED/);
  const look=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:'first-look'});
  assert.equal(look.sha256,catalog.outputs[0].sha256);
  assert.equal(look.probe.codec,'h264'); assert.equal(look.probe.frames,6);
  const agentLook=await s.command(s.credentials.agent,{type:'inspect',revision:1,artifact:'first-look'});
  await assert.rejects(s.command(s.credentials.agent,{type:'approve',revision:1,inspectionId:agentLook.id}),/AUTHORIZATION/);
  await assert.rejects(s.command(s.credentials.agent,{type:'approve',revision:1,inspectionId:look.id,approved:true,role:'human'}),/STRUCTURE/);
  await s.command(s.credentials.human,{type:'edit',revision:1,prompt:'New plan'});
  await assert.rejects(s.command(s.credentials.human,{type:'approve',revision:2,inspectionId:look.id}),/REVIEW_SCOPE/);
  const current=await s.command(s.credentials.human,{type:'inspect',revision:2,artifact:'first-look'});
  await s.command(s.credentials.human,{type:'approve',revision:2,inspectionId:current.id});
  await assert.rejects(s.command(s.credentials.human,{type:'approve',revision:2,inspectionId:current.id}),/REVIEW_EXISTS/);
  const [review]=await fresh('SELECT * FROM spike.reviews');
  assert.equal(review.request_fingerprint,hash(review.request));
  assert.equal(review.request.spec.firstFrame.sha256,catalog.continuity.first.image.sha256);
  assert.equal(review.request.spec.lastFrame.sha256,catalog.continuity.last.image.sha256);
  assert.deepEqual(JSON.parse(review.request.envelope.body).continuity,catalog.continuity);
  assert.equal(JSON.parse(review.request.envelope.body).firstLook.sha256,current.sha256);
  assert.equal((await fresh('SELECT sum(reserved_count)::int AS n FROM spike.grants'))[0].n,0);
  const submit={type:'submit',revision:2,commandId:crypto.randomUUID()};
  const receipt=await s.command(s.credentials.agent,submit);
  assert.deepEqual(await s.command(s.credentials.agent,submit),receipt);
  assert.equal((await fresh('SELECT count(*)::int AS n FROM spike.attempts'))[0].n,1);
  assert.equal((await fresh('SELECT sum(reserved_count)::int AS n FROM spike.grants'))[0].n,1);
  assert.equal((await fresh('SELECT count(*)::int AS n FROM recovery.lifecycle'))[0].n,1);
  assert.equal((await s.read(s.credentials.agent)).selected_take,null);
  await s.command(s.credentials.human,{type:'edit',revision:2,prompt:'Human changes invalidate grant'});
  assert((await fresh('SELECT revoked FROM spike.grants')).every(g=>g.revoked));
  await assert.rejects(s.command(s.credentials.agent,{...submit,commandId:crypto.randomUUID()}),/REVISION_CONFLICT/);
});
test('accepted submit replay precedes mutable revision and grant checks without changing intent',async t=>{
  const {service:s,e,fresh}=await setup(t);
  const look=await s.command(s.credentials.human,{type:'inspect',revision:1,artifact:'first-look'});
  await s.command(s.credentials.human,{type:'approve',revision:1,inspectionId:look.id});
  const command={type:'submit',revision:1,commandId:crypto.randomUUID()};
  const original=await s.command(s.credentials.agent,command);
  const snapshot=async()=>({
    attempts:await fresh('SELECT * FROM spike.attempts'),receipts:await fresh('SELECT * FROM spike.receipts'),
    reservations:await fresh('SELECT * FROM spike.reservations'),grants:await fresh('SELECT * FROM spike.grants ORDER BY id'),
    jobs:await fresh('SELECT id,state FROM pgboss.job ORDER BY id'),
  });
  await s.command(s.credentials.human,{type:'edit',revision:1,prompt:'Human edit after acceptance'});
  const before=await snapshot();
  assert.deepEqual(await s.command(s.credentials.agent,command),original,'accepted replay must return the original receipt after an edit');
  assert.deepEqual(await snapshot(),before,'replay must not create or reserve anything');
  assert.equal((await s.read(s.credentials.human)).prompt,'Human edit after acceptance');
  await assert.rejects(s.command(s.credentials.agent,{...command,revision:2}),/COMMAND_CONFLICT/);
  await assert.rejects(s.command(s.credentials.human,command),/REVISION_CONFLICT/);
  await assert.rejects(s.command(s.credentials.agent,{...command,commandId:crypto.randomUUID()}),/REVISION_CONFLICT/);
  await assert.rejects(s.command(s.credentials.agent,{...command,prompt:'changed intent'}),/STRUCTURE/);
  await assert.rejects(s.command(s.credentials.agent,{...command,type:'edit',prompt:'changed type'}),/STRUCTURE/);
  await assert.rejects(s.command('forged',command),/AUTHORIZATION/);
  const {digest}=await import('../service.ts');
  const foreign='e'.repeat(64);
  await e.pool.query("INSERT INTO parity.sessions VALUES ($1,$2,$3,true,clock_timestamp()+interval '1 hour')",[digest(foreign),crypto.randomUUID(),crypto.randomUUID()]);
  await assert.rejects(s.command(foreign,command),/AUTHORIZATION/);
  const newLook=await s.command(s.credentials.human,{type:'inspect',revision:2,artifact:'first-look'});
  await s.command(s.credentials.human,{type:'approve',revision:2,inspectionId:newLook.id});
  const newApproval=await snapshot();
  assert.deepEqual(await s.command(s.credentials.agent,command),original);
  await assert.rejects(s.command(s.credentials.agent,{...command,revision:2}),/COMMAND_CONFLICT/);
  assert.deepEqual(await snapshot(),newApproval,'old command ID cannot consume a newer review');
});

test('cross-project fixture sessions cannot read or mutate this workspace',async t=>{
  const {service:s,e}=await setup(t);
  const token='f'.repeat(64);
  const {digest}=await import('../service.ts');
  await e.pool.query("INSERT INTO parity.sessions VALUES ($1,$2,$3,true,clock_timestamp()+interval '1 hour')",[digest(token),crypto.randomUUID(),crypto.randomUUID()]);
  await assert.rejects(s.read(token),/AUTHORIZATION/);
  await assert.rejects(s.command(token,{type:'edit',revision:1,prompt:'foreign'}),/AUTHORIZATION/);
});

test('both callers share validation, server identity and revision fences', async t => {
  const {service:s,fresh} = await setup(t);
  for (const token of [s.credentials.human,s.credentials.agent]) {
    await assert.rejects(s.command(token, {type:'edit',revision:1,prompt:'draft',role:'human'}), /STRUCTURE/);
    await assert.rejects(s.command(token, {type:'edit',revision:1,prompt:'draft',route:'live/provider'}), /STRUCTURE/);
    await assert.rejects(s.command(token, {type:'transfer',revision:1}), /CAPABILITY/);
    await assert.rejects(s.command(token, {type:'inspect',revision:1,artifact:'https://untrusted.invalid/a.mp4'}), /STRUCTURE/);
    await assert.rejects(s.command(token, {type:'edit',revision:1,prompt:'swap',firstFrame:{role:'last-frame'}}), /STRUCTURE/);
  }
  await assert.rejects(s.command('forged', {type:'edit',revision:1,prompt:'mine'}), /AUTHORIZATION/);
  const human = await s.command(s.credentials.human,{type:'edit',revision:1,prompt:'Human draft survives'});
  assert.equal(human.revision,2);
  await assert.rejects(s.command(s.credentials.agent,{type:'edit',revision:1,prompt:'stale agent'}),/REVISION_CONFLICT/);
  await assert.rejects(s.command(s.credentials.agent,{type:'submit',revision:1,commandId:crypto.randomUUID()}),/REVISION_CONFLICT/);
  assert.equal((await fresh('SELECT prompt,revision FROM spike.drafts'))[0].prompt,'Human draft survives');
  const agent = await s.command(s.credentials.agent,{type:'edit',revision:2,prompt:'Current authorized edit'});
  assert.equal(agent.revision,3);
});
