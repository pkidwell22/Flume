import type { ReviewShot, ReviewTake, ReviewAsset, ReviewExport } from '../src/types';
export const shot: ReviewShot = {id:'shot-a',projectId:'project-a',title:'The opening',revision:4,selectionRevision:2,selectedTakeId:null};
export const take: ReviewTake = {id:'take-a',projectId:shot.projectId,shotId:shot.id,attemptId:'attempt-a',assetId:'asset-a',createdAt:'2026-01-01T12:00:00Z'};
export const asset: ReviewAsset = {id:take.assetId,projectId:shot.projectId,filename:'motion-study.mp4',kind:'video',origin:'sample',sha256:'a'.repeat(64),mediaUrl:'/api/media/asset-a',width:960,height:540,durationSeconds:2};
export const frozen: ReviewExport = {id:'export-a',projectId:shot.projectId,shotId:shot.id,takeId:take.id,shotRevision:shot.revision,selectionRevision:3,status:'ready',assetId:'output-a',stale:false};
