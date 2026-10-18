import { z } from 'zod';

/** Platform resource UUIDs, matching HTTP and PostgreSQL. Validate only: never trim or change case.
 * Provider/model/job/output identifiers are opaque strings and must not use this schema. */
export const IdSchema = z.string().uuid();
export const CommandIdSchema = z.string().uuid();
export const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const MoneyUsdSchema = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/);
export const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

/** Draft controls retain unsupported intent; provider review checks compatibility. */
export const ControlsSchema = z.object({
  modelId: z.string().max(200),
  durationSeconds: z.number().finite().nonnegative(),
  resolution: z.string().max(100),
  aspectRatio: z.string().max(100),
  generateAudio: z.boolean(),
  seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export const BindingsSchema = z.object({
  firstFrameAssetId: IdSchema.nullable(),
  lastFrameAssetId: IdSchema.nullable(),
}).strict();
export const ShotPatchSchema = z.object({
  title: z.string().max(500).optional(),
  prompt: z.string().max(100_000).optional(),
  controls: ControlsSchema.partial().extend({ seed: ControlsSchema.shape.seed.unwrap().nullable().optional() }).optional(),
  bindings: BindingsSchema.partial().optional(),
}).strict();

export const ShotUpdateCommandSchema = z.object({
  type: z.literal('shot.update'),
  commandId: CommandIdSchema,
  projectId: IdSchema,
  shotId: IdSchema,
  expectedRevision: RevisionSchema,
  patch: ShotPatchSchema,
}).strict();
const commandBase = { commandId: CommandIdSchema };
const projectCommand = { ...commandBase, projectId: IdSchema };
const shotCommand = { ...projectCommand, shotId: IdSchema, expectedRevision: RevisionSchema };
export const ProjectCreateCommandSchema = z.object({
  ...commandBase, type: z.literal('project.create'), name: z.string().min(1).max(500), brief: z.string().max(100_000),
}).strict();
export const ShotCreateCommandSchema = z.object({
  ...projectCommand, type: z.literal('shot.create'), title: z.string().max(500), prompt: z.string().max(100_000),
}).strict();
export const GenerationPrepareCommandSchema = z.object({ ...shotCommand, type: z.literal('generation.prepare') }).strict();
export const MAX_APPROVAL_ATTEMPTS = 100;
export const GenerationApproveCommandSchema = z.object({
  ...projectCommand, type: z.literal('generation.approve'), reviewId: IdSchema,
  maxAttempts: z.number().int().positive().max(MAX_APPROVAL_ATTEMPTS), maxCostUsd: MoneyUsdSchema.nullable(),
}).strict();
export const GenerationSubmitCommandSchema = z.object({
  ...projectCommand, type: z.literal('generation.submit'), reviewId: IdSchema,
}).strict();
export const AttemptResumeCommandSchema = z.object({
  ...projectCommand, type: z.literal('attempt.resume'), attemptId: IdSchema,
}).strict();
export const TakeInspectCommandSchema = z.object({
  ...projectCommand, type: z.literal('take.inspect'), takeId: IdSchema,
}).strict();
export const TakeSelectCommandSchema = z.object({
  ...shotCommand, type: z.literal('take.select'), expectedSelectionRevision: RevisionSchema,
  takeId: IdSchema, inspectionId: IdSchema,
}).strict();
export const ExportCreateCommandSchema = z.object({
  ...shotCommand, type: z.literal('export.create'), expectedSelectionRevision: RevisionSchema,
}).strict();
const agentCommands = [
  ProjectCreateCommandSchema, ShotCreateCommandSchema, ShotUpdateCommandSchema,
  GenerationPrepareCommandSchema, GenerationSubmitCommandSchema, AttemptResumeCommandSchema,
  TakeInspectCommandSchema, TakeSelectCommandSchema, ExportCreateCommandSchema,
] as const;
export const AgentCommandSchema = z.discriminatedUnion('type', agentCommands);
export const CommandSchema = z.discriminatedUnion('type', [...agentCommands, GenerationApproveCommandSchema]);
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
export type ProjectCreateCommand = z.infer<typeof ProjectCreateCommandSchema>;
export type ShotCreateCommand = z.infer<typeof ShotCreateCommandSchema>;
export type ShotUpdateCommand = z.infer<typeof ShotUpdateCommandSchema>;
export type GenerationPrepareCommand = z.infer<typeof GenerationPrepareCommandSchema>;
export type GenerationApproveCommand = z.infer<typeof GenerationApproveCommandSchema>;
export type GenerationSubmitCommand = z.infer<typeof GenerationSubmitCommandSchema>;
export type AttemptResumeCommand = z.infer<typeof AttemptResumeCommandSchema>;
export type TakeInspectCommand = z.infer<typeof TakeInspectCommandSchema>;
export type TakeSelectCommand = z.infer<typeof TakeSelectCommandSchema>;
export type ExportCreateCommand = z.infer<typeof ExportCreateCommandSchema>;
export type Controls = z.infer<typeof ControlsSchema>;
export type Bindings = z.infer<typeof BindingsSchema>;
export type ShotPatch = z.infer<typeof ShotPatchSchema>;
export type Command = z.infer<typeof CommandSchema>;

export const ProjectSchema = z.object({
  id: IdSchema, name: z.string(), brief: z.string(), revision: RevisionSchema,
}).strict();
export const ShotSchema = z.object({
  id: IdSchema, projectId: IdSchema, title: z.string(), prompt: z.string(), revision: RevisionSchema,
  controls: ControlsSchema, bindings: BindingsSchema, selectedTakeId: IdSchema.nullable(), selectionRevision: RevisionSchema,
}).strict();
export const AssetSchema = z.object({
  id: IdSchema, projectId: IdSchema, filename: z.string().min(1),
  kind: z.enum(['image', 'video']), origin: z.enum(['imported', 'generated', 'sample']),
  sha256: Sha256Schema, mediaUrl: z.string().min(1),
  width: z.number().int().positive(), height: z.number().int().positive(),
  durationSeconds: z.number().finite().nonnegative().optional(),
  provenance: z.record(z.unknown()).optional(),
}).strict();
export const TakeSchema = z.object({
  id: IdSchema, projectId: IdSchema, shotId: IdSchema, attemptId: IdSchema, assetId: IdSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export const AttemptStatusSchema = z.enum(['queued', 'running', 'retrieving', 'ready', 'blocked', 'failed', 'acceptance_unknown']);
export const AttemptSchema = z.object({
  id: IdSchema, projectId: IdSchema, shotId: IdSchema, shotRevision: RevisionSchema,
  status: AttemptStatusSchema, providerJobId: z.string().nullable(), errorCode: z.string().nullable(), message: z.string().nullable(),
}).strict();
export const BlockerSchema = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict();
/** Informational USD estimate bound to the exact provider body, never a spend cap. */
export const CatalogEstimateSchema = z.object({
  status: z.literal('estimated'), provider: z.literal('openrouter'), modelId: z.literal('minimax/hailuo-3'),
  currency: z.literal('USD'), bodySha256: Sha256Schema, estimatedCostUsd: MoneyUsdSchema,
  basis: z.literal('catalog_pricing_skus'),
  label: z.literal('Catalog-based estimate; not a quote or provider-enforced spend cap.'),
  providerEnforcedSpendCap: z.literal(false),
  lineItems: z.array(z.object({sku: z.enum(['duration_seconds', 'reference_images']), quantity: z.number().int().positive(),
    unitPriceUsd: MoneyUsdSchema, estimatedCostUsd: MoneyUsdSchema}).strict()).min(1).max(2).readonly(),
}).strict();
export type CatalogEstimate = z.infer<typeof CatalogEstimateSchema>;
export const ReviewSchema = z.object({
  id: IdSchema, projectId: IdSchema, shotId: IdSchema, shotRevision: RevisionSchema,
  requestHash: Sha256Schema, prompt: z.string(), controls: ControlsSchema, bindings: BindingsSchema,
  estimatedCostUsd: MoneyUsdSchema.nullable(), estimate: CatalogEstimateSchema.optional(), blockers: z.array(BlockerSchema), approved: z.boolean(),
}).strict();
export const ExportStatusSchema = z.enum(['queued', 'running', 'ready', 'failed']);
export const ExportSchema = z.object({
  id: IdSchema, projectId: IdSchema, shotId: IdSchema, takeId: IdSchema,
  shotRevision: RevisionSchema, selectionRevision: RevisionSchema, status: ExportStatusSchema,
  assetId: IdSchema.nullable(), stale: z.boolean(),
}).strict();
/** Domain roles are first/last; provider translators own wire-specific frame_type values. */
export const FrameRoleSchema = z.enum(['first', 'last']);
export const CapabilitySchema = z.object({
  modelId: z.string().min(1), name: z.string().min(1), durations: z.array(z.number().finite().positive()),
  resolutions: z.array(z.string().min(1)), frameRoles: z.array(FrameRoleSchema), seedSupported: z.boolean(),
  // Optional read metadata: absence is unknown, not unsupported. Never infer entitlement.
  aspectRatios: z.array(z.string().min(1)).optional(), generateAudioSupported: z.boolean().optional(),
  availability: z.enum(['available', 'blocked', 'unknown']), blocker: z.string().nullable(),
}).strict();
export const WorkspaceSchema = z.object({
  project: ProjectSchema.nullable(), shots: z.array(ShotSchema), assets: z.array(AssetSchema), takes: z.array(TakeSchema),
  attempts: z.array(AttemptSchema), reviews: z.array(ReviewSchema), exports: z.array(ExportSchema), capabilities: z.array(CapabilitySchema),
}).strict();
export const CommandReceiptSchema = z.object({
  commandId: CommandIdSchema, projectId: IdSchema, resourceId: IdSchema.optional(), revision: RevisionSchema.optional(),
  attemptId: IdSchema.optional(), reviewId: IdSchema.optional(), exportId: IdSchema.optional(),
}).strict();
export const ApiErrorSchema = z.object({
  code: z.string().min(1), message: z.string(), currentRevision: RevisionSchema.optional(), details: z.unknown().optional(),
}).strict();

export type Project = z.infer<typeof ProjectSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Take = z.infer<typeof TakeSchema>;
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Blocker = z.infer<typeof BlockerSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type ExportStatus = z.infer<typeof ExportStatusSchema>;
export type Export = z.infer<typeof ExportSchema>;
export type FrameRole = z.infer<typeof FrameRoleSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

export function emptyWorkspace(): Workspace {
  return { project: null, shots: [], assets: [], takes: [], attempts: [], reviews: [], exports: [], capabilities: [] };
}
