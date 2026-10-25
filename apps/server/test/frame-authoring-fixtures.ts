// Labeled controlled fixture: in-memory store, provider port and media port.
// No network, no database, no provider credentials. Not live-provider evidence.
import {createHash, randomUUID} from 'node:crypto';
import {createFrameAuthoringService} from '../src/frame-authoring.ts';
import type {
  FrameAuthoringStore, FrameCapability, FrameDraftInput, FrameEnvelope, FrameMediaPort, FrameOwnedAsset,
  FramePrepared, FrameProviderPort, FrameReference, FrameReviewRecord, FrameReviewStatus, FrameRole,
  FrameShotSnapshot, FrameSubmission, FrameTransitionPatch,
} from '../src/frame-authoring.ts';

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const PROJECT = '00000001-0000-4000-8000-000000000001';
export const OTHER_PROJECT = '00000001-0000-4000-8000-0000000000ff';
export const SHOT = '00000002-0000-4000-8000-000000000002';
export const SOURCE_ASSET = '00000007-0000-4000-8000-000000000007';
export const OPERATOR = {id: '00000004-0000-4000-8000-000000000004', kind: 'operator', projectIds: '*'} as const;
export const AGENT: {id: string; kind: 'agent'; projectIds: string[]} = {id: '00000005-0000-4000-8000-000000000005', kind: 'agent', projectIds: [PROJECT]};

export function pngBytes(width = 64, height = 64) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = Buffer.alloc(21);
  chunk.writeUInt32BE(13, 0); chunk.write('IHDR', 4, 'ascii');
  chunk.writeUInt32BE(width, 8); chunk.writeUInt32BE(height, 12);
  chunk[16] = 8; chunk[17] = 6;
  return new Uint8Array(Buffer.concat([header, chunk]));
}
export function jpegBytes(width = 40, height = 30) {
  const soi = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const dims = Buffer.alloc(4);
  dims.writeUInt16BE(height, 0); dims.writeUInt16BE(width, 2);
  return new Uint8Array(Buffer.concat([soi, dims, Buffer.from([0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9])]));
}
export function webpBytes(width = 33, height = 21) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii'); buffer.writeUInt32LE(22, 4); buffer.write('WEBPVP8X', 8, 'ascii');
  buffer.writeUInt32LE(10, 16); buffer[20] = 0; buffer[21] = 0; buffer[22] = 0; buffer[23] = 0;
  buffer.writeUIntLE(width - 1, 24, 3); buffer.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(buffer);
}
export function sniff(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.length >= 24 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return {mimeType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20)};
  if (b.length >= 10 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; i++) {
      if (b[i] === 0xff && [0xc0, 0xc1, 0xc2].includes(b[i + 1])) return {mimeType: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7)};
    }
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    if (b.toString('ascii', 12, 16) === 'VP8X') return {mimeType: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3)};
  }
  throw new Error('FIXTURE_UNSUPPORTED_IMAGE');
}

const key = (projectId: string, id: string) => `${projectId}:${id}`;
type ShotRow = FrameShotSnapshot & {projectId: string};

export interface MemoryStoreSeed {
  shots: {id: string; projectId: string; revision: number; bindings: {firstFrameAssetId: string | null; lastFrameAssetId: string | null}}[];
  assets: {id: string; projectId: string; kind: 'image' | 'video'; sha256: string; mimeType: string; byteSize: number}[];
}
export function createMemoryFrameAuthoringStore(seed: MemoryStoreSeed) {
  const shots = new Map(seed.shots.map(shot => [key(shot.projectId, shot.id), structuredClone(shot)]));
  const assets = new Map(seed.assets.map(asset => [key(asset.projectId, asset.id), structuredClone(asset)]));
  const reviews = new Map();
  const results = new Map();
  const claims = new Map<string, {projectId: string; reviewId: string; assetId: string; sha256: string; status: 'importing' | 'imported'}>();
  const bindingLog: unknown[] = [];
  const importClaimLog: {status: string; assetId: string}[] = [];
  let mutations = 0;
  const clone = <T>(value: T): T => structuredClone(value);
  const store: FrameAuthoringStore & {
    bindingLog: unknown[]; importClaimLog: {status: string; assetId: string}[]; mutations: () => number; bumpShot(projectId: string, shotId: string): void;
    registerAsset(asset: FrameOwnedAsset): void;
    tamperReview(id: string, patch: Record<string, unknown>): void;
    assetSnapshot(): Map<string, FrameOwnedAsset>;
    claimSnapshot(): Map<string, {projectId: string; reviewId: string; assetId: string; sha256: string; status: 'importing' | 'imported'}>;
  } = {
    bindingLog,
    importClaimLog,
    claimSnapshot: () => new Map([...claims].map(([k, v]) => [k, clone(v)])),
    mutations: () => mutations,
    registerAsset(asset) {
      assets.set(key(asset.projectId, asset.id), clone(asset));
      mutations++;
    },
    bumpShot(projectId, shotId) {
      const shot = shots.get(key(projectId, shotId));
      if (!shot) throw new Error('FIXTURE_SHOT_MISSING');
      shot.revision += 1;
      mutations++;
    },
    tamperReview(reviewId, patch) {
      const review = reviews.get(reviewId);
      if (!review) throw new Error('FIXTURE_REVIEW_MISSING');
      Object.assign(review, patch);
      mutations++;
    },
    assetSnapshot: () => new Map([...assets].map(([k, v]) => [k, clone(v)])),
    async getShot(projectId, shotId) {
      const shot = shots.get(key(projectId, shotId)) as ShotRow | undefined;
      return shot ? {id: shot.id, revision: shot.revision, bindings: clone(shot.bindings)} : null;
    },
    async getAsset(projectId, assetId) {
      const asset = assets.get(key(projectId, assetId));
      return asset ? {id: asset.id, projectId: asset.projectId, kind: asset.kind, sha256: asset.sha256, mimeType: asset.mimeType, byteSize: asset.byteSize} : null;
    },
    async insertReview(record: FrameReviewRecord) {
      if (reviews.has(record.reviewId)) throw new Error('FIXTURE_DUPLICATE_REVIEW');
      reviews.set(record.reviewId, clone(record));
      mutations++;
    },
    async getReview(projectId, reviewId) {
      const review = reviews.get(reviewId);
      return review && review.projectId === projectId ? clone(review) : null;
    },
    async findResult(projectId, reviewId) {
      const result = [...results.values()].find(row => row.projectId === projectId && row.reviewId === reviewId);
      return result ? clone(result) : null;
    },
    async transition({projectId, reviewId, from, to, patch}: {projectId: string; reviewId: string; from: FrameReviewStatus[]; to: FrameReviewStatus; patch?: FrameTransitionPatch}) {
      const review = reviews.get(reviewId);
      if (!review || review.projectId !== projectId || !from.includes(review.status)) return null;
      Object.assign(review, {status: to}, clone(patch ?? {}));
      mutations++;
      return clone(review);
    },
    async insertResult(row) {
      if ([...results.values()].some(existing => existing.reviewId === row.reviewId)) return false;
      results.set(row.assetId, clone(row));
      mutations++;
      return true;
    },
    // Fixture only: the read-then-write below never awaits, so it is atomic for this harness. It is
    // NOT evidence that the SQL claim is atomic; the coordinator runs the real PostgreSQL tests.
    async claimResultImport({projectId, reviewId, assetId, sha256}) {
      const recorded = [...results.values()].find(row => row.projectId === projectId && row.reviewId === reviewId);
      if (recorded) return {status: 'already_imported', assetId: recorded.assetId, result: clone(recorded)};
      const existing = claims.get(reviewId);
      if (existing) {
        const sameIntent = existing.projectId === projectId && existing.assetId === assetId && existing.sha256 === sha256;
        importClaimLog.push({status: sameIntent ? 'resume' : 'in_progress', assetId});
        return sameIntent
          ? {status: 'claimed', assetId: existing.assetId, result: null}
          : {status: 'in_progress', assetId: existing.assetId, result: null};
      }
      const review = reviews.get(reviewId);
      if (!review || review.projectId !== projectId || review.status !== 'submitted') {
        importClaimLog.push({status: 'unavailable', assetId});
        return {status: 'unavailable', assetId: null, result: null};
      }
      claims.set(reviewId, {projectId, reviewId, assetId, sha256, status: 'importing'});
      importClaimLog.push({status: 'claimed', assetId});
      mutations++;
      return {status: 'claimed', assetId, result: null};
    },
    async completeResultImport({projectId, reviewId, assetId}) {
      const claim = claims.get(reviewId);
      if (claim && claim.projectId === projectId && claim.assetId === assetId) { claim.status = 'imported'; mutations++; }
    },
    async bindFrame({projectId, shotId, expectedRevision, role, assetId, reviewId, actorId}) {
      const shot = shots.get(key(projectId, shotId));
      const asset = assets.get(key(projectId, assetId));
      const review = reviews.get(reviewId);
      if (!shot || shot.revision !== expectedRevision || !asset || asset.kind !== 'image' || !review
        || review.status !== 'result_ready' || review.projectId !== projectId || review.shotId !== shotId
        || review.role !== role || review.expectedRevision !== expectedRevision) return null;
      const before = shot.revision;
      const field = role === 'first_frame' ? 'firstFrameAssetId' : 'lastFrameAssetId';
      shot.bindings = {...shot.bindings, [field]: assetId};
      shot.revision += 1;
      review.status = 'bound';
      review.resultAssetId = assetId;
      const entry = {projectId, shotId, role, assetId, reviewId, revisionBefore: before, revisionAfter: shot.revision, actorId};
      bindingLog.push(entry);
      mutations++;
      return {revision: shot.revision, bindings: clone(shot.bindings), review: clone(review)};
    },
  };
  return store;
}

export function createFixtureMedia(register?: (asset: FrameOwnedAsset & {width: number; height: number}) => void) {
  const reads: unknown[] = [];
  const imports: unknown[] = [];
  const owned = new Map();
  const written = new Set<string>();
  const media: FrameMediaPort & {reads: unknown[]; imports: unknown[]; seedOwned(projectId: string, assetId: string, bytes: Uint8Array): void} = {
    reads, imports,
    seedOwned(projectId, assetId, bytes) { owned.set(key(projectId, assetId), Buffer.from(bytes)); },
    async readOwned({projectId, assetId}) {
      reads.push({projectId, assetId});
      const bytes = owned.get(key(projectId, assetId));
      if (!bytes) throw new Error('FIXTURE_MEDIA_MISSING');
      return new Uint8Array(bytes);
    },
    async importOwned(input) {
      imports.push({...input, bytes: undefined});
      // Real owners are content-addressed by the supplied id: re-importing the same id is refused
      // rather than silently overwriting, which is what makes the resume path testable here.
      if (written.has(key(input.projectId, input.id))) throw new Error('FIXTURE_MEDIA_DUPLICATE_ASSET');
      written.add(key(input.projectId, input.id));
      const {width, height} = sniff(input.bytes);
      const asset: FrameOwnedAsset & {width: number; height: number} = {
        id: input.id, projectId: input.projectId, kind: 'image', sha256: sha256(input.bytes),
        mimeType: input.mimeType, byteSize: input.bytes.length, width, height,
      };
      register?.(asset);
      return asset;
    },
  };
  return media;
}

export interface FixtureProviderOverrides {
  capabilities?: FrameCapability[];
  prepare?: (input: {role: FrameRole; prompt: string; modelId: string; aspectRatio: string; reference: FrameReference | null}) => FramePrepared | Promise<FramePrepared>;
  submit?: (envelope: FrameEnvelope) => FrameSubmission | Promise<FrameSubmission>;
}
export function createFixtureProvider(overrides: FixtureProviderOverrides = {}) {
  const prepareCalls: unknown[] = [];
  const submitCalls: unknown[] = [];
  const provider: FrameProviderPort & {prepareCalls: unknown[]; submitCalls: unknown[]} = {
    prepareCalls, submitCalls,
    async capabilities(): Promise<FrameCapability[]> {
      return overrides.capabilities ?? [{
        modelId: 'google/gemini-2.5-flash-image', name: 'Gemini image (fixture)',
        aspectRatios: ['1:1', '16:9', '9:16'], availability: 'available', blocker: null,
      }];
    },
    async prepare(input) {
      prepareCalls.push(input);
      if (typeof overrides.prepare === 'function') return overrides.prepare(input);
      const reference = input.reference ? {assetId: input.reference.assetId, sha256: input.reference.sha256} : null;
      const body = JSON.stringify({model: input.modelId, prompt: input.prompt, aspect_ratio: input.aspectRatio, reference});
      return {envelope: {provider: 'openrouter', modelId: input.modelId, body, bodySha256: sha256(body)}, estimateUsd: null, blockers: []};
    },
    async submit(envelope) {
      submitCalls.push(envelope);
      if (typeof overrides.submit === 'function') return overrides.submit(envelope);
      const bytes = pngBytes(64, 64);
      return {status: 'accepted', receipt: {providerModelId: envelope.modelId, providerReceiptId: 'gen-fixture-1', costUsd: null},
        image: {mimeType: 'image/png', width: 64, height: 64, sha256: sha256(bytes), bytes}};
    },
  };
  return provider;
}

export function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {resolve = () => res(); reject = rej;});
  return {promise, resolve, reject};
}

export interface HarnessOptions { provider?: FixtureProviderOverrides; draft?: FrameDraftInput }
export function harness(overrides: HarnessOptions = {}) {
  const sourceBytes = pngBytes(80, 45);
  const store = createMemoryFrameAuthoringStore({
    shots: [{id: SHOT, projectId: PROJECT, revision: 3, bindings: {firstFrameAssetId: null, lastFrameAssetId: null}}],
    assets: [
      {id: SOURCE_ASSET, projectId: PROJECT, kind: 'image', sha256: sha256(sourceBytes), mimeType: 'image/png', byteSize: sourceBytes.length},
      {id: '00000007-0000-4000-8000-0000000000aa', projectId: OTHER_PROJECT, kind: 'image', sha256: sha256(sourceBytes), mimeType: 'image/png', byteSize: sourceBytes.length},
    ],
  });
  const media = createFixtureMedia(asset => store.registerAsset(asset));
  media.seedOwned(PROJECT, SOURCE_ASSET, sourceBytes);
  media.seedOwned(OTHER_PROJECT, '00000007-0000-4000-8000-0000000000aa', sourceBytes);
  const provider = createFixtureProvider(overrides.provider ?? {});
  let sequence = 0;
  const service = createFrameAuthoringService({
    store, media, provider,
    ids: {reviewId: () => `0000000a-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      assetId: () => `0000000b-0000-4000-8000-${String(++sequence).padStart(12, '0')}`},
    clock: () => new Date('2026-10-24T12:00:00.000Z'),
  });
  const draft: FrameDraftInput = overrides.draft ?? {
    projectId: PROJECT, shotId: SHOT, expectedRevision: 3, role: 'first_frame',
    prompt: '  keep literal café 🟠 spacing\n', modelId: 'google/gemini-2.5-flash-image',
    aspectRatio: '16:9', sourceAssetId: SOURCE_ASSET,
  };
  return {store, media, provider, service, draft, sourceBytes};
}

export function codeOf(error: unknown): string | undefined { return (error as {code?: string} | null)?.code; }
