import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ownedPostgres } from '../../../packages/database/test/owned-postgres.ts';

import { createCommandService } from '../src/index.ts';
import { migrate } from '@flume/database';

const operator={id:'11111111-1111-4111-8111-111111111111',kind:'operator' as const,projectIds:'*' as const};

test('persistent project creation replays its original receipt across service restart',async()=>{
  const owned=await ownedPostgres();
  try {
    const mod=await import('../src/index.ts').catch(()=>null);
    assert.ok(mod?.createCommandService,'persistent command service is implemented');
    const {migrate}=await import('@flume/database'); await migrate(owned.pool);
    const service=mod.createCommandService({pool:owned.pool});
    const command={type:'project.create',commandId:randomUUID(),name:'Real project',brief:'Owned local work'};
    const first=await service.command(operator,command);
    const independent=new pg.Pool(owned.config);
    try {
      assert.equal((await independent.query('SELECT name FROM flume.projects WHERE id=$1',[first.projectId])).rows[0].name,'Real project');
      const restarted=mod.createCommandService({pool:independent});
      assert.deepEqual(await restarted.command(operator,command),first);
      assert.equal((await restarted.listProjects(operator)).length,1);
      await assert.rejects(restarted.command(operator,{...command,name:'different'}),{code:'COMMAND_CONFLICT'});
    } finally {await independent.end();}
  } finally {await owned.close();}
});
