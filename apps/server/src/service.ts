import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '@flume/database';
import { actorSchema, commandSchema, hash, authorize, ServiceError, defaultControls,uuid,sha256, type Actor,type Receipt } from './contracts.ts';
import { projectDto,shotDto,assetDto, type Workspace } from './dto.ts';
import { lockShot } from './store-helpers.ts';
import { generationCommand,preparedSchema,estimateMatchesEnvelope,type Prepared } from './generation.ts';
import { blockedProvider,durableOutboxQueue,type ProviderPort,type TransactionalQueuePort,type MediaPort } from './ports.ts';
import { selectionCommand,type PreparedInspection } from './selection.ts';
import { getTakeAsset,ownedAsset,ownedAssetSchema,insertAsset } from './assets.ts';
import { projectReferenceReceipt,type ReferenceProvenanceRow,type ReferenceReceipt } from './reference-provenance.ts';
export type ServiceOptions={pool:Pool;provider?:ProviderPort;queue?:TransactionalQueuePort;workerAvailable?:boolean;media?:MediaPort};
export function createCommandService({pool,provider=blockedProvider,queue=durableOutboxQueue,workerAvailable=false,media}:ServiceOptions) {
  async function listProjects(raw:Actor) {
    const actor=actorSchema.parse(raw);
    const result=await pool.query('SELECT id,name,brief,revision FROM flume.projects WHERE ($1::uuid[] IS NULL OR id=ANY($1::uuid[])) ORDER BY created_at,id',[actor.projectIds==='*'?null:actor.projectIds]);
    return result.rows.map(projectDto);
  }
  async function getWorkspace(raw:Actor,projectId?:string):Promise<Workspace> {
    const actor=actorSchema.parse(raw);
    const empty:Workspace={project:null,shots:[],assets:[],takes:[],attempts:[],reviews:[],exports:[],capabilities:[]};
    try{empty.capabilities=await provider.capabilities();}
    catch{empty.capabilities=[{modelId:defaultControls.modelId,name:'Provider catalog unavailable',durations:[],resolutions:[],frameRoles:[],seedSupported:false,availability:'unknown',blocker:'The provider catalog is unavailable. Local editing remains available.'}];}
    if(!projectId)return empty;
    uuid.parse(projectId);authorize(actor,projectId);
    return await transaction(pool,async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const project=(await c.query('SELECT * FROM flume.projects WHERE id=$1',[projectId])).rows[0];
      if(!project)throw new ServiceError('PROJECT_NOT_FOUND','Project not found.',404);
      empty.attempts=(await c.query('SELECT a.id,a.project_id,a.shot_id,a.shot_revision,a.status,a.provider_job_id,a.error_code,a.message,(SELECT count(*)>1 FROM flume.worker_receipts r WHERE r.attempt_id=a.id) AS receipt_conflict FROM flume.attempts a WHERE project_id=$1 ORDER BY a.created_at,a.id',[projectId])).rows.map(r=>({id:r.id,projectId:r.project_id,shotId:r.shot_id,shotRevision:r.shot_revision,status:r.receipt_conflict?'blocked':r.status,providerJobId:r.provider_job_id,errorCode:r.receipt_conflict?'IDENTITY_CONFLICT':r.error_code,message:r.receipt_conflict?'Conflicting provider acceptance evidence requires investigation. Existing owned media is retained.':r.message}));
      empty.reviews=(await c.query(`SELECT r.*, (a.review_id IS NOT NULL AND NOT a.revoked AND a.expires_at>clock_timestamp() AND r.consumed_attempt_id IS NULL AND r.shot_revision=s.revision) AS approved FROM flume.reviews r JOIN flume.shots s ON s.id=r.shot_id LEFT JOIN flume.approvals a ON a.review_id=r.id WHERE r.project_id=$1 ORDER BY r.created_at,r.id`,[projectId])).rows.map(r=>({id:r.id,projectId:r.project_id,shotId:r.shot_id,shotRevision:r.shot_revision,requestHash:r.request_hash,prompt:r.snapshot.prompt,controls:r.snapshot.controls,bindings:r.snapshot.bindings,estimatedCostUsd:r.estimated_cost_usd,...(r.snapshot.estimate?{estimate:r.snapshot.estimate}:{}),blockers:r.blockers.map((b:string|{code:string;message:string})=>typeof b==='string'?{code:'GENERATION_BLOCKED',message:b}:b),approved:r.approved}));
      empty.takes=(await c.query('SELECT * FROM flume.takes WHERE project_id=$1 ORDER BY created_at,id',[projectId])).rows.map(r=>({id:r.id,projectId:r.project_id,shotId:r.shot_id,attemptId:r.attempt_id,assetId:r.asset_id,createdAt:r.created_at.toISOString()}));
      empty.exports=(await c.query('SELECT * FROM flume.exports WHERE project_id=$1 ORDER BY created_at,id',[projectId])).rows.map(r=>({id:r.id,projectId:r.project_id,shotId:r.shot_id,takeId:r.take_id,shotRevision:r.shot_revision,selectionRevision:r.selection_revision,status:r.status,assetId:r.asset_id,stale:r.stale}));
      return {...empty,project:projectDto(project),shots:(await c.query('SELECT * FROM flume.shots WHERE project_id=$1 ORDER BY created_at,id',[projectId])).rows.map(shotDto),assets:(await c.query('SELECT * FROM flume.assets WHERE project_id=$1 ORDER BY created_at,id',[projectId])).rows.map(assetDto)};
    });
  }
  async function command(rawActor:Actor,raw:unknown):Promise<Receipt> {
    const actor=actorSchema.parse(rawActor),cmd=commandSchema.parse(raw),fingerprint=hash(cmd);
    if('projectId' in cmd)authorize(actor,cmd.projectId);
    let prepared:Prepared|undefined,inspection:PreparedInspection|undefined;
    if(cmd.type==='generation.prepare'||cmd.type==='take.inspect') {
      const replay=(await pool.query('SELECT fingerprint,receipt,project_id FROM flume.command_receipts WHERE actor_id=$1 AND command_id=$2',[actor.id,cmd.commandId])).rows[0];
      if(replay){authorize(actor,replay.project_id);if(replay.fingerprint!==fingerprint)throw new ServiceError('COMMAND_CONFLICT','This command ID already accepted different intent.');return replay.receipt;}
    }
    if(cmd.type==='generation.prepare') {
      const w=await getWorkspace(actor,cmd.projectId),shot=w.shots.find(s=>s.id===cmd.shotId.toLowerCase());
      if(!shot)throw new ServiceError('SHOT_NOT_FOUND','Shot not found.',404);
      if(shot.revision!==cmd.expectedRevision)throw new ServiceError('REVISION_CONFLICT','This shot changed.',409,shot.revision);
      const result=preparedSchema.parse(await provider.prepare(structuredClone({projectId:cmd.projectId,shot,assets:w.assets})));
      if(result.envelope&&(result.envelope.modelId!==shot.controls.modelId||sha256(result.envelope.body)!==result.envelope.bodySha256))throw new ServiceError('PREPARATION_INTEGRITY','The provider envelope does not match the requested model or exact bytes.',422);
      if(!estimateMatchesEnvelope(result))throw new ServiceError('PREPARATION_INTEGRITY','The catalog estimate must match the exact prepared request and amount.',422);
      if(!workerAvailable)result.blockers.push('The background worker is not attached.');
      prepared={snapshot:{...(result.estimate?{estimate:result.estimate}:{}),projectId:cmd.projectId,shotId:shot.id,shotRevision:shot.revision,prompt:shot.prompt,controls:shot.controls,bindings:shot.bindings,assets:w.assets.filter(a=>Object.values(shot.bindings).some(id=>id?.toLowerCase()===a.id)).map(a=>({id:a.id,sha256:a.sha256}))},result};
    }
    if(cmd.type==='take.inspect') {
      if(!media)throw new ServiceError('MEDIA_UNAVAILABLE','Owned media inspection is not configured.',503);
      const a=await getTakeAsset(pool,cmd.projectId,cmd.takeId);
      const shot=(await pool.query('SELECT revision FROM flume.shots WHERE id=$1',[a.shot_id])).rows[0];
      await media.verifyOwned(ownedAsset(a));
      inspection={shotRevision:shot.revision,sha256:a.sha256,takeId:a.take_id};
    }
    return await transaction(pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`command/${actor.id.toLowerCase()}/${cmd.commandId.toLowerCase()}`]);
      const replay=(await client.query('SELECT fingerprint,receipt,project_id FROM flume.command_receipts WHERE actor_id=$1 AND command_id=$2',[actor.id,cmd.commandId])).rows[0];
      if(replay){authorize(actor,replay.project_id);if(replay.fingerprint!==fingerprint)throw new ServiceError('COMMAND_CONFLICT','This command ID already accepted different intent.');return replay.receipt;}
      if(cmd.type==='attempt.resume')await client.query('SELECT attempt_id FROM flume.worker_checkpoints WHERE attempt_id=$1 FOR UPDATE',[cmd.attemptId]);
      let receipt:Receipt;
      if(cmd.type==='project.create') {
        if(actor.projectIds!=='*')throw new ServiceError('FORBIDDEN','Project creation is not granted.',403);
        const projectId=randomUUID();
        await client.query('INSERT INTO flume.projects (id,name,brief) VALUES ($1,$2,$3)',[projectId,cmd.name,cmd.brief]);
        receipt={commandId:cmd.commandId,projectId,resourceId:projectId,revision:1};
      }else {
        const projectId=cmd.projectId;
        if(!(await client.query('SELECT id FROM flume.projects WHERE id=$1',[projectId])).rowCount)throw new ServiceError('PROJECT_NOT_FOUND','Project not found.',404);
        if(cmd.type==='shot.create') {
          const shotId=randomUUID();
          await client.query('INSERT INTO flume.shots (id,project_id,title,prompt,controls,bindings) VALUES ($1,$2,$3,$4,$5,$6)',[shotId,projectId,cmd.title,cmd.prompt,defaultControls,{firstFrameAssetId:null,lastFrameAssetId:null}]);
          receipt={commandId:cmd.commandId,projectId,resourceId:shotId,revision:1};
        }else if(cmd.type==='shot.update') {
          const shot=await lockShot(client,projectId,cmd.shotId,cmd.expectedRevision);
          const bindings={...shot.bindings,...cmd.patch.bindings};
          for(const id of Object.values(bindings)) if(id!==null && !(await client.query("SELECT id FROM flume.assets WHERE id=$1 AND project_id=$2 AND kind='image'",[id,projectId])).rowCount)throw new ServiceError('ASSET_SCOPE','Frame references must be owned images in this project.');
          const controls={...shot.controls,...cmd.patch.controls};
          if(controls.seed===null)delete controls.seed;
          await client.query('UPDATE flume.shots SET title=$2,prompt=$3,controls=$4,bindings=$5,revision=revision+1 WHERE id=$1',[shot.id,cmd.patch.title??shot.title,cmd.patch.prompt??shot.prompt,controls,bindings]);
          await client.query('UPDATE flume.approvals SET revoked=true WHERE review_id IN (SELECT id FROM flume.reviews WHERE shot_id=$1)',[shot.id]);
          await client.query('UPDATE flume.exports SET stale=true WHERE shot_id=$1',[shot.id]);
          receipt={commandId:cmd.commandId,projectId,resourceId:shot.id,revision:shot.revision+1};
        }else if(cmd.type.startsWith('generation.')){receipt=await generationCommand(client,actor,cmd,queue,prepared);}
        else {receipt=await selectionCommand(client,actor,cmd,queue,inspection);}
      }
      await client.query('INSERT INTO flume.command_receipts (actor_id,command_id,fingerprint,project_id,receipt) VALUES ($1,$2,$3,$4,$5)',[actor.id,cmd.commandId,fingerprint,receipt.projectId,receipt]);
      return receipt;
    });
  }
  async function uploadAsset(raw:Actor,input:{projectId:string;filename:string;mimeType:string;bytes:Uint8Array}) {
    const actor=actorSchema.parse(raw);uuid.parse(input.projectId);authorize(actor,input.projectId);
    if(!media)throw new ServiceError('MEDIA_UNAVAILABLE','Local media import is not configured.',503);
    if(!input.bytes.byteLength||input.bytes.byteLength>32*1024*1024)throw new ServiceError('IMPORT_LIMIT','Imports must be between 1 byte and 32 MiB.',413);
    if(!input.filename||input.filename.length>255||/[\/\\\x00-\x1f]/.test(input.filename))throw new ServiceError('INVALID_FILENAME','A plain filename without path separators is required.',400);
    if(!(await pool.query('SELECT id FROM flume.projects WHERE id=$1',[input.projectId])).rowCount)throw new ServiceError('PROJECT_NOT_FOUND','Project not found.',404);
    const id=randomUUID(),asset=ownedAssetSchema.parse(await media.importLocal({...input,id}));
    if(asset.id!==id||asset.projectId.toLowerCase()!==input.projectId.toLowerCase()||asset.origin!=='imported'||asset.sha256!==sha256(input.bytes)||asset.byteSize!==input.bytes.byteLength)throw new ServiceError('IMPORT_INTEGRITY','Imported bytes or ownership do not match.',422);
    await media.verifyOwned(asset);
    return await transaction(pool,async c=>assetDto(await insertAsset(c,asset)));
  }
  async function readMedia(raw:Actor,assetId:string) {
    const actor=actorSchema.parse(raw);uuid.parse(assetId);
    const row=(await pool.query('SELECT * FROM flume.assets WHERE id=$1',[assetId])).rows[0];
    if(!row)throw new ServiceError('ASSET_NOT_FOUND','Asset not found.',404);authorize(actor,row.project_id);
    if(!media)throw new ServiceError('MEDIA_UNAVAILABLE','Owned media reading is not configured.',503);
    const asset=ownedAssetSchema.parse(ownedAsset(row)),bytes=Buffer.from(await media.readOwned(asset));
    if(bytes.byteLength!==asset.byteSize||sha256(bytes)!==asset.sha256)throw new ServiceError('MEDIA_INTEGRITY','Owned media bytes failed integrity verification.',422);
    return {bytes,mimeType:asset.mimeType,sha256:asset.sha256};
  }
  async function extractReferenceFrame(raw:Actor,input:{projectId:string;assetId:string;frame:'first'|'last'}) {
    const actor=actorSchema.parse(raw);uuid.parse(input.projectId);uuid.parse(input.assetId);authorize(actor,input.projectId);
    if(actor.kind!=='operator')throw new ServiceError('OPERATOR_REQUIRED','Only the configured operator may extract reference frames.',403);
    if(input.frame!=='first'&&input.frame!=='last')throw new ServiceError('INVALID_FRAME_MODE','Frame must be first or last.',400);
    if(!media?.extractFrame)throw new ServiceError('MEDIA_UNAVAILABLE','Reference frame extraction is not configured.',503);
    const row=(await pool.query("SELECT * FROM flume.assets WHERE id=$1 AND project_id=$2 AND kind='video'",[input.assetId,input.projectId])).rows[0];
    if(!row)throw new ServiceError('ASSET_NOT_FOUND','Owned source video not found in this project.',404);
    const source=ownedAssetSchema.parse(ownedAsset(row));await media.verifyOwned(source);
    const id=randomUUID(),derived=ownedAssetSchema.parse(await media.extractFrame({id,projectId:input.projectId,sourceAssetId:source.id,frame:input.frame}));
    const provenance=derived.provenance as Record<string,unknown>|undefined;
    if(derived.id!==id||derived.projectId.toLowerCase()!==input.projectId.toLowerCase()||derived.kind!=='image'||derived.mimeType!=='image/png'||
      provenance?.kind!=='extracted-frame'||provenance.sourceAssetId!==source.id||provenance.sourceSha256!==source.sha256||provenance.frame!==input.frame)
      throw new ServiceError('EXTRACTION_INTEGRITY','Extracted frame provenance or ownership does not match the source.',422);
    await media.verifyOwned(derived);
    return await transaction(pool,async c=>assetDto(await insertAsset(c,derived)));
  }
  /**
   * Read-only recorded reference history for one generation. One project-scoped SELECT, no
   * write, lock, migration or provider call, and no read of current shots, assets or selection.
   * The project grant is checked before the lookup, so an unwelcome actor learns nothing about
   * whether the attempt exists: absent and cross-project attempts are the same typed 404.
   */
  async function readReferenceProvenance(rawActor:Actor,input:{projectId:string;attemptId:string}):Promise<ReferenceReceipt> {
    const actor=actorSchema.parse(rawActor),projectId=uuid.parse(input.projectId),attemptId=uuid.parse(input.attemptId);
    authorize(actor,projectId);
    const row=(await pool.query(`SELECT a.id AS attempt_id,a.project_id AS attempt_project_id,a.shot_id AS attempt_shot_id,a.shot_revision AS attempt_shot_revision,
      a.review_id,r.id AS review_id_row,r.project_id AS review_project_id,r.shot_id AS review_shot_id,r.shot_revision AS review_shot_revision,
      r.request_hash,r.created_at AS recorded_at,r.snapshot
      FROM flume.attempts a JOIN flume.reviews r ON r.id=a.review_id
      WHERE a.id=$1 AND a.project_id=$2 AND r.project_id=$2`,[attemptId,projectId])).rows[0];
    if(!row)throw new ServiceError('PROVENANCE_NOT_FOUND','No recorded reference history is available for this attempt.',404);
    const receipt=projectReferenceReceipt(row as ReferenceProvenanceRow);
    // The receipt must describe exactly the identity that was authorized.
    if(receipt.projectId.toLowerCase()!==projectId.toLowerCase()||receipt.attemptId.toLowerCase()!==attemptId.toLowerCase())
      throw new ServiceError('PROVENANCE_INCONSISTENT','The recorded review does not match this attempt.',409);
    return receipt;
  }
  async function health(){await pool.query('SELECT 1');return {ok:true,store:'postgresql',workerAvailable};}
  return {command,listProjects,getWorkspace,uploadAsset,readMedia,extractReferenceFrame,readReferenceProvenance,health};
}
