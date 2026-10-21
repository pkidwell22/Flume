import { z } from 'zod';
import { uuid } from './contracts.ts';

export const CHAT_MODELS = ['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash', 'openai/gpt-4.1-mini'] as const;
export const ChatModelSchema = z.enum(CHAT_MODELS);
export const ChatUsageSchema = z.strictObject({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative() });
export const ChatContextSchema = z.strictObject({
  project: z.strictObject({ id: uuid, name: z.string(), brief: z.string() }),
  shot: z.strictObject({ id: uuid, title: z.string(), prompt: z.string(), revision: z.number().int(), aspectRatio: z.string() }).nullable(),
  assets: z.array(z.strictObject({ id: uuid, filename: z.string(), kind: z.string(), origin: z.string(), width: z.number(), height: z.number() })).max(4),
  disclosure: z.array(z.string()),
});
export const ChatMessageSchema = z.strictObject({
  id: uuid, requestId: uuid.nullable(), role: z.enum(['user', 'assistant']),
  status: z.enum(['completed', 'streaming', 'stopped', 'error']), content: z.string().max(64_000),
  createdAt: z.string().datetime(), usage: ChatUsageSchema.nullable(), error: z.string().max(500).nullable(),
  requestFingerprint: z.string().max(128).nullable().default(null), recordedContext: ChatContextSchema.nullable().default(null),
});
export const ShotEditProposalSchema = z.strictObject({
  id: uuid, requestId: uuid, requestFingerprint: z.string().length(64), applyCommandId: uuid,
  actorId: uuid, projectId: uuid, conversationId: uuid, shotId: uuid, modelId: ChatModelSchema,
  instruction: z.string().trim().min(1).max(4_000),
  before: z.strictObject({ title: z.string(), prompt: z.string(), revision: z.number().int().nonnegative() }),
  after: z.strictObject({ title: z.string().max(240), prompt: z.string().max(20_000) }).nullable(),
  rationale: z.string().max(1_000).nullable(),
  status: z.enum(['inferring', 'pending', 'applying', 'applied', 'dismissed', 'failed', 'reconciliation']),
  failure: z.string().max(500).nullable(), appliedRevision: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type ShotEditProposal = z.infer<typeof ShotEditProposalSchema>;
export const ProposalProviderResultSchema = z.strictObject({ title: z.string().max(240), prompt: z.string().max(20_000), rationale: z.string().max(1_000) });
export const ChatConversationSchema = z.strictObject({
  id: uuid, actorId: uuid, projectId: uuid, title: z.string().trim().min(1).max(120), modelId: ChatModelSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), messages: z.array(ChatMessageSchema).max(400), proposals: z.array(ShotEditProposalSchema).max(200).default([]),
});
export type ChatConversation = z.infer<typeof ChatConversationSchema>;
export type ChatUsage = z.infer<typeof ChatUsageSchema>;
export type ChatContextRecord = z.infer<typeof ChatContextSchema>;
export const CreateChatSchema = z.strictObject({ projectId: uuid, title: z.string().trim().min(1).max(120).default('New conversation'), modelId: ChatModelSchema });
export const RenameChatSchema = z.strictObject({ projectId: uuid, title: z.string().trim().min(1).max(120) });
export const SendChatSchema = z.strictObject({
  projectId: uuid, requestId: uuid, modelId: ChatModelSchema, content: z.string().trim().min(1).max(12_000),
  context: z.strictObject({ shotId: uuid.nullable().optional(), assetIds: z.array(uuid).max(4).default([]) }).default({ assetIds: [] }),
});
export const ProposeShotEditSchema = z.strictObject({ projectId: uuid, requestId: uuid, modelId: ChatModelSchema, shotId: uuid, instruction: z.string().trim().min(1).max(4_000) });
export const ProposalActionSchema = z.strictObject({ projectId: uuid });

export class ChatError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); this.name = 'ChatError'; }
}
