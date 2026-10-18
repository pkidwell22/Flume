import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { CommandSchema, WorkspaceSchema } from '@flume/domain';
import { migrate } from '@flume/database';
import { createCommandService } from '../src/service.ts';
import { ownedPostgres } from '../../../packages/database/test/owned-postgres.ts';
const actor={id:randomUUID(),kind:'operator' as const,projectIds:'*' as const};
test('canonical client reads real blocked review; seed zero, omission and explicit clearing are distinct',async()=>{
 const db=await ownedPostgres();
 try {
  await migrate(db.pool);const service=createCommandService({pool:db.pool});
  const send=(body:object)=>service.command(actor,{commandId:randomUUID(),...body});
  const {projectId}=await send({type:'project.create',name:'Contract',brief:''});
  const shotId=(await send({type:'shot.create',projectId,title:'One',prompt:'Literal  '})).resourceId!;
  await send({type:'generation.prepare',projectId,shotId,expectedRevision:1});
  assert.equal(WorkspaceSchema.parse(await service.getWorkspace(actor,projectId)).reviews[0].blockers.length,2);
  await send({type:'shot.update',projectId,shotId,expectedRevision:1,patch:{controls:{seed:0}}});
  await send({type:'shot.update',projectId,shotId,expectedRevision:2,patch:{controls:{generateAudio:false}}});
  assert.equal((await service.getWorkspace(actor,projectId)).shots[0].controls.seed,0);
  const clear=CommandSchema.parse({type:'shot.update',commandId:randomUUID(),projectId,shotId,expectedRevision:3,patch:{controls:{seed:null}}});
  await service.command(actor,clear);
  assert.equal(Object.hasOwn((await service.getWorkspace(actor,projectId)).shots[0].controls,'seed'),false);
  assert.equal(CommandSchema.safeParse({type:'generation.approve',commandId:randomUUID(),projectId,reviewId:randomUUID(),maxAttempts:1,maxCostUsd:null}).success,true);
 } finally {await db.close();}
});
