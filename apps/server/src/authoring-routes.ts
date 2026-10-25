/**
 * HTTP route surface for frame authoring, storyboard proposals and shot continuation.
 *
 * Every route runs after buildServer's existing Host/Origin/actor hook and receives the actor that
 * hook already resolved; there is no second authentication path here. Payloads are strict objects,
 * errors are server-authored codes with safe messages, and raw provider envelopes, receipts,
 * staging paths and keys never appear in a response.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ServiceError } from './contracts.ts';
import { FrameAuthoringError } from './frame-authoring.ts';
import { StoryboardProposalError } from './storyboard-proposals.ts';
import type { Actor } from './frame-authoring.ts';
import type { AuthoringRuntime } from './authoring-runtime.ts';

const id = z.string().uuid();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/);

const DraftSchema = z.strictObject({
  projectId: id, shotId: id, expectedRevision: revision,
  role: z.enum(['first_frame', 'last_frame']),
  prompt: z.string().min(1).max(8000).refine(value => value.trim().length > 0, 'Prompt must contain visible characters.'),
  modelId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/),
  aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/),
  sourceAssetId: id.nullable().optional(),
}).strict();

const GenerateSchema = z.strictObject({ projectId: id, expectedRevision: revision, maxCostUsd: money }).strict();
const ImportSchema = z.strictObject({ projectId: id }).strict();
const BindSchema = z.strictObject({
  projectId: id, shotId: id, role: z.enum(['first_frame', 'last_frame']), assetId: id, expectedRevision: revision,
}).strict();
const ProjectQuerySchema = z.strictObject({ projectId: id }).strict();
const ContinuationParamsSchema = z.strictObject({ operationId: id }).strict();
const ContinuationResumeSchema = z.strictObject({ projectId: id }).strict();
const ReviewParamsSchema = z.strictObject({ reviewId: id }).strict();
const ProposalParamsSchema = z.strictObject({ proposalId: id }).strict();

const plainObject = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('INVALID_REQUEST', 'A JSON object body is required.', 400);
  }
  return value as Record<string, unknown>;
};

/** Convert domain refusals into the existing safe error envelope. Raw internals never pass through. */
function rethrow(error: unknown): never {
  if (error instanceof FrameAuthoringError) {
    throw new ServiceError(error.code, error.message.slice(0, 500), error.status, error.currentRevision, error.details);
  }
  if (error instanceof StoryboardProposalError) {
    throw new ServiceError(error.code, error.message.slice(0, 500), error.status, error.currentRevision, error.details);
  }
  if (error instanceof z.ZodError) {
    throw new ServiceError('INVALID_REQUEST', 'The request does not match the strict authoring contract.', 400);
  }
  throw error;
}

const run = <T>(work: () => Promise<T>): Promise<T> => work().catch(rethrow);

export interface AuthoringRouteOptions {
  /** Resolved by buildServer's onRequest hook for this exact request. */
  getActor(request: FastifyRequest): Actor;
  authoring: AuthoringRuntime;
}

export function registerAuthoringRoutes(app: FastifyInstance, options: AuthoringRouteOptions): void {
  const { authoring, getActor } = options;

  const requireStoryboard = () => {
    if (!authoring.storyboard) {
      throw new ServiceError('STORYBOARD_NOT_CONFIGURED', authoring.storyboardBlocker, 503);
    }
    return authoring.storyboard;
  };
  const requireContinueShot = () => {
    if (!authoring.continueShot) {
      throw new ServiceError('CONTINUE_SHOT_NOT_CONFIGURED', authoring.continueShotBlocker, 503);
    }
    return authoring.continueShot;
  };

  app.get('/api/authoring/capabilities', async request =>
    run(() => authoring.capabilities()));

  app.post('/api/frame-reviews', async (request, reply) =>
    run(async () => reply.code(201).send(
      await authoring.createReview(getActor(request), DraftSchema.parse(request.body)),
    )));

  app.get('/api/frame-reviews/:reviewId', async request =>
    run(async () => {
      const { reviewId } = ReviewParamsSchema.parse(request.params);
      const { projectId } = ProjectQuerySchema.parse(request.query);
      return authoring.readReview(getActor(request), { projectId, reviewId });
    }));

  app.post('/api/frame-reviews/:reviewId/generate', async request =>
    run(async () => {
      const { reviewId } = ReviewParamsSchema.parse(request.params);
      const body = GenerateSchema.parse(request.body);
      return authoring.generate(getActor(request), { projectId: body.projectId, reviewId, expectedRevision: body.expectedRevision, maxCostUsd: body.maxCostUsd });
    }));

  app.post('/api/frame-reviews/:reviewId/import', async request =>
    run(async () => {
      const { reviewId } = ReviewParamsSchema.parse(request.params);
      const { projectId } = ImportSchema.parse(request.body);
      return authoring.importResult(getActor(request), { projectId, reviewId });
    }));

  app.post('/api/frame-reviews/:reviewId/bind', async request =>
    run(async () => {
      const { reviewId } = ReviewParamsSchema.parse(request.params);
      const body = BindSchema.parse(request.body);
      return authoring.bind(getActor(request), { ...body, reviewId });
    }));

  app.post('/api/storyboard-proposals', async (request, reply) =>
    run(async () => {
      const storyboard = requireStoryboard();
      const body = plainObject(request.body);
      return reply.code(201).send(await storyboard.propose(getActor(request), body));
    }));

  app.get('/api/storyboard-proposals/:proposalId', async request =>
    run(async () => {
      const storyboard = requireStoryboard();
      const { proposalId } = ProposalParamsSchema.parse(request.params);
      const { projectId } = ProjectQuerySchema.parse(request.query);
      return storyboard.read(getActor(request), { projectId, proposalId });
    }));

  for (const action of ['edit', 'accept', 'resume', 'cancel'] as const) {
    app.post(`/api/storyboard-proposals/:proposalId/${action}`, async request =>
      run(async () => {
        const storyboard = requireStoryboard();
        const { proposalId } = ProposalParamsSchema.parse(request.params);
        const body = plainObject(request.body);
        // The path owns proposal identity; the proposal service owns revision and payload validation.
        return storyboard[action === 'edit' ? 'revise' : action](getActor(request), { ...body, proposalId });
      }));
  }

  app.post('/api/continue-shot', async request =>
    run(async () => {
      const continueShot = requireContinueShot();
      return continueShot.continueShot(getActor(request), plainObject(request.body) as never);
    }));

  // Recovery is a read: it returns a minimal snapshot and triggers no extraction, create or bind.
  app.get('/api/continue-shot/:operationId', async request =>
    run(async () => {
      const continueShot = requireContinueShot();
      const { operationId } = ContinuationParamsSchema.parse(request.params);
      const { projectId } = ProjectQuerySchema.parse(request.query);
      return continueShot.readContinueShot(getActor(request), { projectId, operationId });
    }));

  // Resume carries identity only. The frozen prompt/title/take are replayed from the server journal,
  // so no changed intention can be submitted under an existing operation id.
  app.post('/api/continue-shot/:operationId/resume', async request =>
    run(async () => {
      const continueShot = requireContinueShot();
      const { operationId } = ContinuationParamsSchema.parse(request.params);
      const { projectId } = ContinuationResumeSchema.parse(request.body);
      return continueShot.resumeContinueShot(getActor(request), { projectId, operationId });
    }));
}
