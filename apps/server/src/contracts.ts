import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CommandSchema, IdSchema, MAX_APPROVAL_ATTEMPTS } from '@flume/domain';
export const uuid=IdSchema;
export const actorSchema=z.strictObject({id:uuid,kind:z.enum(['operator','agent']),projectIds:z.union([z.literal('*'),z.array(uuid)])});
export type Actor=z.infer<typeof actorSchema>;
// Canonical application commands and platform UUIDs are shared with HTTP and persistence.
export { ControlsSchema as controlsSchema, BindingsSchema as bindingsSchema, RevisionSchema as revision } from '@flume/domain';
export const defaultControls={modelId:'minimax/hailuo-3',durationSeconds:5,resolution:'2K',aspectRatio:'16:9',generateAudio:false};
export const money=z.string().regex(/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/);
export const commandSchema=CommandSchema.superRefine((cmd,ctx)=>{
 for(const [key,value] of Object.entries(cmd))if(key.endsWith('Id')&&!uuid.safeParse(value).success)ctx.addIssue({code:'custom',path:[key],message:'A UUID resource identifier is required.'});
 if(cmd.type==='shot.update')for(const [key,value] of Object.entries(cmd.patch.bindings??{}))if(value!==null&&!uuid.safeParse(value).success)ctx.addIssue({code:'custom',path:['patch','bindings',key],message:'A UUID asset identifier is required.'});
 if(cmd.type==='generation.approve'&&(cmd.maxAttempts>MAX_APPROVAL_ATTEMPTS||(cmd.maxCostUsd!==null&&!money.safeParse(cmd.maxCostUsd).success)))ctx.addIssue({code:'custom',message:'Approval limits exceed supported precision or count.'});
});
export type Command=z.infer<typeof commandSchema>;
export type Receipt={commandId:string;projectId:string;resourceId?:string;revision?:number;attemptId?:string;reviewId?:string;exportId?:string};
export class ServiceError extends Error {
  constructor(public code:string,message:string,public status=409,public currentRevision?:number,public details?:unknown){super(message);this.name='ServiceError';}
}
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function authorize(actor:Actor,projectId:string){
  if(actor.projectIds!=='*'&&!actor.projectIds.some(id=>id.toLowerCase()===projectId.toLowerCase())) throw new ServiceError('FORBIDDEN','Project access is not granted.',403);
}
