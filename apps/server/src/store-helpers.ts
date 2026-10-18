import type { PoolClient } from 'pg';
import { ServiceError } from './contracts.ts';
export async function lockShot(c:PoolClient,projectId:string,shotId:string,expected?:number) {
 const shot=(await c.query('SELECT * FROM flume.shots WHERE project_id=$1 AND id=$2 FOR UPDATE',[projectId,shotId])).rows[0];
 if(!shot)throw new ServiceError('SHOT_NOT_FOUND','Shot not found.',404);
 if(expected!==undefined&&shot.revision!==expected)throw new ServiceError('REVISION_CONFLICT','This shot changed. Reload before applying a new command.',409,shot.revision);
 return shot;
}
