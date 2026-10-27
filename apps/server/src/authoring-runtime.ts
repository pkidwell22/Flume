/**
 * Runtime composition for frame authoring.
 *
 * Everything that spends money, reads credentials or touches provider availability is injected
 * configuration. The default is an explicitly blocked image route that exposes no models, no
 * estimates and no submit path; nothing here reads process.env, files or provider URLs.
 *
 * Two layers:
 *  - createConfiguredFrameAuthoring(): production builder. Real SQL review store, real owned-media
 *    adapter, durable staging, and an OpenRouter image provider only when configuration supplies
 *    literal model ids and (optionally) per-model estimates.
 *  - createAuthoringRuntime(): route-facing facade over a real FrameAuthoringService plus the
 *    storyboard/continuation services. Services that are not configured stay explicitly blocked.
 *
 * The storyboard/continuation durable stores belong to the durable worker
 * (`createSqlStoryboardStore` / `createSqlContinueShotJournal`). Until those modules land, the
 * facade accepts an already-constructed service and reports the exact missing seam instead of
 * substituting an in-memory store.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { transaction } from '@flume/database';
import { insertAsset, ownedAsset, ownedAssetSchema } from './assets.ts';
import { sha256 } from './contracts.ts';
import { createSqlFrameAuthoringStore, type FrameSqlExecutor } from './frame-authoring-store.ts';
import { createFrameOutputStaging } from './frame-output-staging.ts';
import {
  createFrameAuthoringService, MAX_FRAME_RESULT_BYTES, type Actor, type FrameAuthoringService,
  type FrameBindingView, type FrameCapability, type FrameEnvelope, type FrameMediaPort, type FrameOwnedAsset,
  type FramePrepared, type FrameProviderPort, type FrameResultView, type FrameResultStagingPort,
  type FrameReviewView, type FrameRole, type FrameSubmission,
} from './frame-authoring.ts';
import type { MediaPort } from './ports.ts';
import type { ChatProvider } from './chat-service.ts';
import { createChatStoryboardPlanner, type StoryboardPlannerConfiguration } from './storyboard-planner.ts';
import { createStoryboardProposalService, type StoryboardCommandPort, type StoryboardPlanner, type StoryboardProposalService, type StoryboardProposalStore } from './storyboard-proposals.ts';
import { createContinueShot, type ContinueShotJournal, type ContinueShotOutcome, type ContinueShotPublicView, type ContinueShotRequest } from './continue-shot.ts';
import { createSqlStoryboardStore } from './storyboard-store.ts';
import { createSqlContinueShotJournal } from './continue-shot-store.ts';
import type { AuthoringSqlExecutor } from './authoring-operation-lock.ts';
import type { Command, Receipt } from './contracts.ts';
// The providers package index is coordinator-owned; import the first-wave image modules directly.
import { createOpenRouterImageProvider } from '../../../packages/providers/src/image-generation-openrouter.ts';
import { isImageAuthoringTransport, type ImageAuthoringTransport } from '../../../packages/providers/src/image-generation.ts';

export const BLOCKED_IMAGE_MESSAGE = 'Image generation is not configured on this server. No image models are enabled and no cost estimate is available.';
export const BLOCKED_STORYBOARD_MESSAGE = 'Storyboard proposals are not configured on this server.';
export const BLOCKED_CONTINUATION_MESSAGE = 'Shot continuation is not configured on this server.';

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/;
const MONEY = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/;

export interface FrameModelConfiguration {
  modelId: string;
  name: string;
  aspectRatios?: readonly string[];
  availability: 'available' | 'blocked' | 'unknown';
  blocker?: string | null;
}

/** Explicit server configuration. Absence of a model id or estimate means unknown, never available. */
export type ImageAuthoringConfiguration =
  | { mode: 'blocked'; blocker?: string }
  | {
    mode: 'openrouter';
    models: readonly FrameModelConfiguration[];
    estimatesUsd?: Readonly<Record<string, string>>;
    /**
     * Wire route for newly compiled requests. Defaults to the historical chat-completions body;
     * `images` opts into the native OpenRouter Image API. Routing of already frozen envelopes is
     * derived from their own body, so changing this never re-routes reviewed work.
     */
    transport?: ImageAuthoringTransport;
    /** Server-only credential accessor; never logged or serialized. */
    getApiKey: () => string | undefined;
  };

export interface AuthoringCapabilities {
  imageModels: Array<FrameCapability & { frameRoles: FrameRole[] }>;
  storyboard: { available: boolean; blocker: string | null };
}

export interface AuthoringRuntime {
  capabilities(): Promise<AuthoringCapabilities>;
  createReview(actor: Actor, draft: unknown): Promise<FrameReviewView>;
  readReview(actor: Actor, input: { projectId: string; reviewId: string }): Promise<{ review: FrameReviewView; result: FrameResultView | null }>;
  generate(actor: Actor, input: { projectId: string; reviewId: string; expectedRevision: number; maxCostUsd: string }): Promise<{ review: FrameReviewView; result: FrameResultView | null }>;
  importResult(actor: Actor, input: { projectId: string; reviewId: string }): Promise<FrameResultView>;
  bind(actor: Actor, input: { projectId: string; reviewId: string; shotId: string; role: FrameRole; assetId: string; expectedRevision: number }): Promise<FrameBindingView>;
  /** Null means the storyboard route is intentionally unavailable, never a silent in-memory fallback. */
  storyboard: StoryboardProposalService | null;
  storyboardBlocker: string;
  continueShot: {
    continueShot(actor: Actor, request: ContinueShotRequest): Promise<ContinueShotOutcome>;
    readContinueShot(actor: Actor, input: { projectId: string; operationId: string }): Promise<ContinueShotPublicView>;
    resumeContinueShot(actor: Actor, input: { projectId: string; operationId: string }): Promise<ContinueShotOutcome>;
  } | null;
  continueShotBlocker: string;
}

/** Adapter from the first-wave image provider contract to the frame service port. */
export function createFrameProvider(configuration: ImageAuthoringConfiguration, options: { fetch?: typeof globalThis.fetch } = {}): FrameProviderPort {
  if (configuration?.mode === 'blocked') {
    const blocker = typeof configuration.blocker === 'string' && configuration.blocker.trim().length > 0
      ? configuration.blocker.slice(0, 300) : BLOCKED_IMAGE_MESSAGE;
    return {
      async capabilities() { return []; },
      async prepare(): Promise<FramePrepared> {
        return { envelope: null, estimateUsd: null, blockers: [{ code: 'provider_not_configured', message: blocker }] };
      },
      async submit(): Promise<FrameSubmission> {
        return { status: 'blocked', error: { code: 'provider_not_configured' } };
      },
    };
  }
  if (configuration?.mode !== 'openrouter') throw new TypeError('Image authoring configuration must be blocked or openrouter.');
  if (typeof configuration.getApiKey !== 'function') throw new TypeError('OpenRouter image authoring requires a server-side credential accessor.');

  const models = [...(configuration.models ?? [])];
  if (models.length > 200) throw new TypeError('At most 200 image models may be configured.');
  const ratios = /^\d{1,2}:\d{1,2}$/;
  const seen = new Set<string>();
  for (const model of models) {
    if (!model || typeof model.modelId !== 'string' || !MODEL_ID.test(model.modelId)) throw new TypeError('Configured image models need literal provider/model ids.');
    if (seen.has(model.modelId)) throw new TypeError('Configured image models must not repeat a model id.');
    seen.add(model.modelId);
    if (typeof model.name !== 'string' || model.name.length === 0 || model.name.length > 200) throw new TypeError('Configured image models need a display name.');
    if (!['available', 'blocked', 'unknown'].includes(model.availability)) throw new TypeError('Configured image model availability must be available, blocked or unknown.');
    if (model.aspectRatios && (!Array.isArray(model.aspectRatios) || model.aspectRatios.length > 24 || !model.aspectRatios.every(ratio => typeof ratio === 'string' && ratios.test(ratio)))) {
      throw new TypeError('Configured aspect ratios must be literal W:H values.');
    }
  }
  const estimates = configuration.estimatesUsd ?? {};
  for (const [modelId, value] of Object.entries(estimates)) {
    if (!MODEL_ID.test(modelId) || typeof value !== 'string' || !MONEY.test(value)) {
      throw new TypeError('Configured image estimates must be exact model ids with literal USD amounts.');
    }
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required for OpenRouter image authoring.');
  const transport = configuration.transport === undefined ? 'chat-completions' : configuration.transport;
  if (!isImageAuthoringTransport(transport)) throw new TypeError('Image authoring transport must be chat-completions or images.');

  const inner = createOpenRouterImageProvider({
    getApiKey: configuration.getApiKey,
    fetch: fetchImpl,
    transport,
    models: models.map(model => ({
      modelId: model.modelId, name: model.name,
      ...(model.aspectRatios ? { aspectRatios: [...model.aspectRatios] } : {}),
      availability: model.availability, blocker: model.blocker ?? null,
    })),
    estimateUsd: intent => Object.hasOwn(estimates, intent.modelId) ? estimates[intent.modelId]! : null,
  });

  return {
    capabilities: async () => (await inner.capabilities()).map(capability => ({
      modelId: capability.modelId,
      name: capability.name ?? capability.modelId,
      ...(capability.aspectRatios ? { aspectRatios: [...capability.aspectRatios] } : {}),
      availability: capability.availability,
      blocker: capability.blocker,
    } as FrameCapability)),
    async prepare(input) {
      const prepared = await inner.prepare({ prompt: input.prompt, modelId: input.modelId, aspectRatio: input.aspectRatio, reference: input.reference });
      return { envelope: prepared.envelope, estimateUsd: prepared.estimateUsd, blockers: prepared.blockers };
    },
    async submit(envelope: FrameEnvelope, call?: { signal?: AbortSignal }): Promise<FrameSubmission> {
      const result = await inner.submit(envelope, call);
      if (result.status !== 'accepted') return { status: result.status, error: { code: result.error.code } };
      return {
        status: 'accepted',
        receipt: {
          providerModelId: result.receipt.providerModelId,
          providerReceiptId: result.receipt.providerReceiptId,
          costUsd: result.receipt.costUsd,
        },
        image: {
          mimeType: result.image.mimeType, width: result.image.width, height: result.image.height,
          sha256: result.image.sha256, bytes: result.image.bytes,
        },
      };
    },
  };
}

/**
 * Real owned-media adapter: owned bytes are read through the media store after a canonical project
 * asset lookup, and imports are written to the media store first, re-verified, then recorded as
 * canonical project asset rows in one transaction.
 */
export function createFrameMediaPort(input: { pool: Pool; media: MediaPort }): FrameMediaPort {
  const { pool, media } = input;
  if (!pool || typeof pool.query !== 'function' || !media) throw new TypeError('A PostgreSQL pool and owned media port are required.');
  return {
    async readOwned({ projectId, assetId }): Promise<Uint8Array> {
      const row = (await pool.query('SELECT * FROM flume.assets WHERE project_id=$1 AND id=$2', [projectId, assetId])).rows[0];
      if (!row) throw new Error('FRAME_ASSET_NOT_FOUND');
      const asset = ownedAssetSchema.parse(ownedAsset(row));
      if (asset.projectId.toLowerCase() !== projectId.toLowerCase() || asset.kind !== 'image') throw new Error('FRAME_ASSET_SCOPE');
      await media.verifyOwned(asset);
      return new Uint8Array(await media.readOwned(asset));
    },
    async importOwned({ id, projectId, filename, mimeType, bytes }): Promise<FrameOwnedAsset & { width: number; height: number }> {
      if (!/^image\/(png|jpeg|webp)$/.test(mimeType) || bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_RESULT_BYTES) {
        throw new Error('FRAME_IMPORT_REFUSED');
      }
      const asset = ownedAssetSchema.parse(await media.importLocal({ id, projectId, filename, mimeType, bytes }));
      if (asset.id !== id || asset.projectId.toLowerCase() !== projectId.toLowerCase() || asset.kind !== 'image'
        || asset.mimeType !== mimeType || asset.sha256 !== sha256(bytes) || asset.byteSize !== bytes.byteLength) {
        throw new Error('FRAME_IMPORT_INTEGRITY');
      }
      await media.verifyOwned(asset);
      await transaction(pool, async client => { await insertAsset(client, asset); });
      return { id: asset.id, projectId: asset.projectId, kind: 'image', sha256: asset.sha256, mimeType: asset.mimeType, byteSize: asset.byteSize, width: asset.width, height: asset.height };
    },
  };
}

export interface ConfiguredFrameAuthoringOptions {
  sql: FrameSqlExecutor;
  media: FrameMediaPort;
  stagingRoot: string;
  configuration: ImageAuthoringConfiguration;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
  ids?: { reviewId?: () => string; assetId?: () => string };
}

/** Production builder: real review store, real media boundary, durable staging, configured provider. */
export function createConfiguredFrameAuthoring(options: ConfiguredFrameAuthoringOptions) {
  const staging: FrameResultStagingPort = createFrameOutputStaging({ root: options.stagingRoot });
  const service = createFrameAuthoringService({
    store: createSqlFrameAuthoringStore(options.sql),
    media: options.media,
    provider: createFrameProvider(options.configuration, { fetch: options.fetch }),
    staging,
    clock: options.clock,
    ids: { reviewId: options.ids?.reviewId ?? (() => randomUUID()), assetId: options.ids?.assetId ?? (() => randomUUID()) },
  });
  return { service, staging, capabilities: () => service.capabilities() };
}

/**
 * Durable journals owned by the durable worker. Migration 011_authoring_journals.sql is part of the
 * repository; these constructors perform no I/O until an operation runs, and neither substitutes an
 * in-memory store.
 */
export function createSqlAuthoringJournals(sql: AuthoringSqlExecutor) {
  if (!sql || typeof sql.query !== 'function') throw new TypeError('A SQL executor with query(text, params) is required.');
  return { storyboardStore: createSqlStoryboardStore(sql), continueShotJournal: createSqlContinueShotJournal(sql) };
}

export type AuthoringCommandPorts = Pick<
  ReturnType<typeof import('./service.ts').createCommandService>,
  'getWorkspace' | 'command' | 'extractReferenceFrame'
>;

/** Real continuation wiring: durable journal plus the existing project-owned command service. */
export function createConfiguredContinuation(input: { journal: ContinueShotJournal; commands: AuthoringCommandPorts }) {
  const { journal, commands } = input;
  return createContinueShot({
    journal,
    getWorkspace: (actor, projectId) => commands.getWorkspace(actor, projectId),
    extractReferenceFrame: (actor, request) => commands.extractReferenceFrame(actor, request),
    command: (actor, command) => commands.command(actor, command),
  });
}

/** Real storyboard wiring: durable proposal store, reviewed shot-create port and a configured planner. */
export function createConfiguredStoryboard(input: {
  store: StoryboardProposalStore; planner: StoryboardPlanner; commands: Pick<AuthoringCommandPorts, 'command'>; now?: () => string;
}) {
  const command: StoryboardCommandPort = async (actor, shot): Promise<Receipt> =>
    input.commands.command(actor, { ...shot } as Command);
  return createStoryboardProposalService({ planner: input.planner, command, store: input.store, now: input.now });
}

/** The registered chat transports plus their explicit credential accessor (see container-chat.ts). */
export type StoryboardChatPort = {
  provider: ChatProvider;
  getCredential(modelId: string): Promise<string | null>;
};

/**
 * Compose the real storyboard service from explicit configuration.
 *
 * `blocked` (the default) yields no service and a plain operator/UI blocker. A configured model is
 * only instantiated when the server credential accessor actually has a credential for it; a missing
 * credential blocks with a plain message instead of guessing or half-configuring a provider. An
 * unregistered model id is a startup configuration error, because a silently blocked planner hides a
 * typo. The planner is the only I/O: proposing still cannot create a shot or spend money.
 */
export async function createConfiguredStoryboardRuntime(input: {
  store: StoryboardProposalStore;
  chat: StoryboardChatPort;
  configuration: StoryboardPlannerConfiguration;
  commands: Pick<AuthoringCommandPorts, 'command'>;
  now?: () => string;
}): Promise<{ storyboard: StoryboardProposalService | null; storyboardBlocker: string }> {
  const { configuration, chat } = input;
  if (configuration.mode === 'blocked') return { storyboard: null, storyboardBlocker: BLOCKED_STORYBOARD_MESSAGE };
  const credential = await chat.getCredential(configuration.modelId);
  if (!credential) {
    return {
      storyboard: null,
      storyboardBlocker: `Storyboard proposals are unavailable: no server credential is configured for the ${configuration.modelId} planner model.`,
    };
  }
  const planner: StoryboardPlanner = createChatStoryboardPlanner({
    provider: chat.provider,
    modelId: configuration.modelId,
    getCredential: () => chat.getCredential(configuration.modelId),
    maxTokens: configuration.maxTokens,
    timeoutMs: configuration.timeoutMs,
    maxResponseChars: configuration.maxResponseChars,
  });
  return {
    storyboard: createConfiguredStoryboard({ store: input.store, planner, commands: input.commands, now: input.now }),
    storyboardBlocker: BLOCKED_STORYBOARD_MESSAGE,
  };
}

export interface AuthoringRuntimeOptions {
  service: FrameAuthoringService;
  /** Availability facts for the capability route; defaults to the service's provider capabilities. */
  capabilities?: () => Promise<Omit<AuthoringCapabilities, 'imageModels'> & { imageModels: FrameCapability[] }>;
  storyboard?: StoryboardProposalService | null;
  storyboardBlocker?: string;
  continueShot?: AuthoringRuntime['continueShot'];
  continueShotBlocker?: string;
}

export function createAuthoringRuntime(options: AuthoringRuntimeOptions): AuthoringRuntime {
  const { service } = options;
  if (!service || typeof service.capabilities !== 'function') throw new TypeError('A real frame authoring service is required.');
  const storyboard = options.storyboard ?? null;
  const continueShot = options.continueShot ?? null;
  const storyboardBlocker = options.storyboardBlocker ?? BLOCKED_STORYBOARD_MESSAGE;
  const continueShotBlocker = options.continueShotBlocker ?? BLOCKED_CONTINUATION_MESSAGE;
  const readCapabilities = options.capabilities ?? (async () => ({
    imageModels: await service.capabilities(),
    storyboard: { available: storyboard !== null, blocker: storyboard === null ? storyboardBlocker : null },
  }));
  const capabilities = async (): Promise<AuthoringCapabilities> => {
    const reported = await readCapabilities();
    return {
      ...reported,
      // Application output binding targets, not video-provider reference-input capabilities.
      // Preserve availability and spend checks, including for injected capability sources.
      imageModels: reported.imageModels.map(model => ({
        ...model, frameRoles: ['first_frame', 'last_frame'],
      })),
    };
  };
  return {
    capabilities,
    createReview: (actor, draft) => service.createReview({ actor, draft }),
    readReview: (actor, input) => service.readReview({ actor, ...input }),
    async generate(actor, input) {
      const outcome = await service.approveAndSubmit({ actor, ...input });
      return { review: outcome.review, result: null };
    },
    importResult: (actor, input) => service.importStagedResult({ actor, ...input }),
    bind: (actor, input) => service.bind({ actor, ...input }),
    storyboard,
    storyboardBlocker,
    continueShot,
    continueShotBlocker,
  };
}
