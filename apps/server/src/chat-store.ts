import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, rename, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { ChatContextSchema, ChatConversationSchema, ChatError, type ChatContextInput, type ChatConversation, type ChatUsage, type ShotEditProposal } from './chat-contracts.ts';
import { uuid } from './contracts.ts';

type Scope = { actorId: string; projectId: string; conversationId: string };
type Create = Omit<Scope, 'conversationId'> & { title: string; modelId: ChatConversation['modelId'] };
export interface ChatStore {
  list(scope: Omit<Scope, 'conversationId'>): Promise<ChatConversation[]>;
  create(input: Create): Promise<ChatConversation>;
  get(scope: Scope): Promise<ChatConversation>;
  rename(scope: Scope & { title: string }): Promise<ChatConversation>;
  beginTurn(input: Scope & { requestId: string; content: string; fingerprint?: string; recordedContext?: ChatContextInput | null }): Promise<{ userMessageId: string; assistantMessageId: string; replayState: 'new' | 'in_progress' | 'completed' | 'stopped' | 'error'; content: string; usage: ChatUsage | null; error: string | null }>;
  setTurnContext(input: Scope & { assistantMessageId: string; recordedContext: ChatContextInput }): Promise<void>;
  appendTurn(input: Scope & { assistantMessageId: string; content: string }): Promise<void>;
  finishTurn(input: Scope & { assistantMessageId: string; content: string; usage: ChatUsage | null }): Promise<void>;
  stopTurn(input: Scope & { assistantMessageId: string; content: string; error?: string }): Promise<void>;
  createProposal(input: Scope & { proposal: ShotEditProposal }): Promise<{ proposal: ShotEditProposal; claimed: boolean }>;
  updateProposal(input: Scope & { proposalId: string; expected: ShotEditProposal['status'][]; patch: Partial<Pick<ShotEditProposal, 'after' | 'rationale' | 'status' | 'failure' | 'appliedRevision'>> }): Promise<ShotEditProposal>;
}

const safe = (value: string) => { const parsed = uuid.safeParse(value); if (!parsed.success) throw new ChatError('INVALID_CHAT_ID', 'Chat identifiers must be literal UUIDs.', 400); return parsed.data; };
export async function createFileChatStore({ root }: { root: string }): Promise<ChatStore> {
  if (!path.isAbsolute(root)) throw new ChatError('INVALID_CHAT_ROOT', 'Chat storage requires an absolute private root.', 500);
  const validateExistingChain = async (candidate: string) => { const parts = path.resolve(candidate).split(path.sep).filter(Boolean); let cursor = path.parse(candidate).root; for (const part of parts) { cursor = path.join(cursor, part); try { if ((await lstat(cursor)).isSymbolicLink() && cursor !== '/var' && cursor !== '/tmp') throw new ChatError('INVALID_CHAT_ROOT', 'Chat storage root and ancestors may not be symlinks.', 500); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } } };
  await validateExistingChain(root); await mkdir(root, { recursive: true, mode: 0o700 });
  root = await realpath(root);
  await chmod(root, 0o700);
  const queues = new Map<string, Promise<unknown>>();
  const liveTurns = new Set<string>();
  const liveProposals = new Set<string>();
  const paths = (scope: Scope) => {
    const actorId = safe(scope.actorId), projectId = safe(scope.projectId), conversationId = safe(scope.conversationId);
    const directory = path.join(root, actorId, projectId); return { directory, file: path.join(directory, `${conversationId}.json`) };
  };
  const serial = async <T>(scope: Scope, work: () => Promise<T>): Promise<T> => {
    const key = `${scope.actorId}/${scope.projectId}/${scope.conversationId}`;
    const previous = queues.get(key) ?? Promise.resolve(); const next = previous.catch(() => {}).then(work);
    queues.set(key, next); try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
  };
  const secureDirectory = async (scope: Pick<Scope, 'actorId' | 'projectId'>) => {
    const actorId = safe(scope.actorId), projectId = safe(scope.projectId), actorDirectory = path.join(root, actorId), directory = path.join(actorDirectory, projectId);
    const ensure = async (candidate: string) => { try { await mkdir(candidate, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } const stat = await lstat(candidate); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ChatError('CHAT_STORE_INVALID', 'Chat storage paths may not be symlinks.', 500); await chmod(candidate, 0o700); };
    await ensure(actorDirectory); await ensure(directory);
    return directory;
  };
  const validateScopeDirectories = async (scope: Pick<Scope, 'actorId' | 'projectId'>) => { const actorId = safe(scope.actorId), projectId = safe(scope.projectId); for (const candidate of [path.join(root, actorId), path.join(root, actorId, projectId)]) { const stat = await lstat(candidate); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ChatError('CHAT_STORE_INVALID', 'Chat storage paths may not be symlinks.', 500); } };
  const read = async (scope: Scope, recover = true): Promise<ChatConversation> => {
    const { file } = paths(scope); let raw: string;
    try { await validateScopeDirectories(scope); const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error('unsafe'); raw = await handle.readFile('utf8'); } finally { await handle.close(); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ChatError('CHAT_NOT_FOUND', 'Conversation not found.', 404); throw new ChatError('CHAT_STORE_INVALID', 'Stored conversation could not be read.', 500); }
    const conversation = ChatConversationSchema.parse(JSON.parse(raw));
    if (conversation.actorId !== scope.actorId || conversation.projectId !== scope.projectId || conversation.id !== scope.conversationId) throw new ChatError('CHAT_SCOPE_MISMATCH', 'Conversation ownership does not match.', 403);
    if (recover && (conversation.messages.some(message => message.status === 'streaming' && !liveTurns.has(message.id)) || conversation.proposals.some(proposal => proposal.status === 'inferring' && !liveProposals.has(proposal.id)))) {
      for (const message of conversation.messages) if (message.status === 'streaming' && !liveTurns.has(message.id)) { message.status = 'stopped'; message.error = 'The server restarted before this response finished.'; }
      for (const proposal of conversation.proposals) if (proposal.status === 'inferring' && !liveProposals.has(proposal.id)) { proposal.status = 'failed'; proposal.failure = 'The server restarted before proposal inference finished. It was not retried.'; proposal.updatedAt = new Date().toISOString(); }
      conversation.updatedAt = new Date().toISOString(); await write(scope, conversation);
    }
    return conversation;
  };
  const write = async (scope: Scope, value: ChatConversation) => {
    const { file } = paths(scope), directory = await secureDirectory(scope);
    try { const existing = await lstat(file); if (!existing.isFile() || existing.isSymbolicLink()) throw new ChatError('CHAT_STORE_INVALID', 'Conversation files may not be symlinks.', 500); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temp = path.join(directory, `.${scope.conversationId}.${randomUUID()}.tmp`); const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(ChatConversationSchema.parse(value))); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file); await chmod(file, 0o600);
  };
  return {
    async list({ actorId, projectId }) {
      safe(actorId); safe(projectId); const directory = path.join(root, actorId, projectId);
      let names: string[]; try { await validateScopeDirectories({ actorId, projectId }); names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const found: ChatConversation[] = [];
      for (const name of names) if (/^[0-9a-f-]{36}\.json$/i.test(name)) { const conversationId = name.slice(0, -5); if (uuid.safeParse(conversationId).success) { const scope = { actorId, projectId, conversationId }; found.push(await serial(scope, () => read(scope))); } }
      return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async create(input) { safe(input.actorId); safe(input.projectId); const now = new Date().toISOString(); const value = ChatConversationSchema.parse({ id: randomUUID(), ...input, createdAt: now, updatedAt: now, messages: [], proposals: [] }); await write({ ...input, conversationId: value.id }, value); return value; },
    get(scope) { return serial(scope, () => read(scope)); },
    rename(scope) { return serial(scope, async () => { const value = await read(scope); value.title = scope.title; value.updatedAt = new Date().toISOString(); await write(scope, value); return value; }); },
    beginTurn(input) { return serial(input, async () => { const fingerprint = input.fingerprint ?? `legacy-content:${input.content}`; const recordedContext = input.recordedContext ? ChatContextSchema.parse(input.recordedContext) : null; const value = await read(input); const prior = value.messages.find(message => message.requestId === input.requestId && message.role === 'user'); if (prior) { if (prior.requestFingerprint !== fingerprint) throw new ChatError('CHAT_REQUEST_CONFLICT', 'This request ID already represents different input.'); const assistant = value.messages.find(message => message.requestId === input.requestId && message.role === 'assistant')!; return { userMessageId: prior.id, assistantMessageId: assistant.id, replayState: assistant.status === 'streaming' ? 'in_progress' : assistant.status, content: assistant.content, usage: assistant.usage, error: assistant.error }; } if (value.messages.some(message => message.role === 'assistant' && message.status === 'streaming')) throw new ChatError('CHAT_TURN_IN_PROGRESS', 'This conversation already has a response in progress.'); const now = new Date().toISOString(), userMessageId = randomUUID(), assistantMessageId = randomUUID(); value.messages.push({ id: userMessageId, requestId: input.requestId, role: 'user', status: 'completed', content: input.content, createdAt: now, usage: null, error: null, requestFingerprint: fingerprint, recordedContext }, { id: assistantMessageId, requestId: input.requestId, role: 'assistant', status: 'streaming', content: '', createdAt: now, usage: null, error: null, requestFingerprint: fingerprint, recordedContext }); value.updatedAt = now; await write(input, value); liveTurns.add(assistantMessageId); return { userMessageId, assistantMessageId, replayState: 'new', content: '', usage: null, error: null }; }); },
    setTurnContext(input) { return serial(input, async () => { const value=await read(input,false),assistant=value.messages.find(message=>message.id===input.assistantMessageId&&message.role==='assistant');if(!assistant||assistant.status!=='streaming')throw new ChatError('CHAT_TURN_NOT_STREAMING','This response is no longer streaming.');const recordedContext=ChatContextSchema.parse(input.recordedContext);for(const message of value.messages)if(message.requestId===assistant.requestId)message.recordedContext=recordedContext;value.updatedAt=new Date().toISOString();await write(input,value); }); },
    appendTurn(input) { return serial(input, async () => { const value = await read(input, false); const message = value.messages.find(item => item.id === input.assistantMessageId && item.role === 'assistant'); if (!message || message.status !== 'streaming') throw new ChatError('CHAT_TURN_NOT_STREAMING', 'This response is no longer streaming.'); message.content = input.content; value.updatedAt = new Date().toISOString(); await write(input, value); }); },
    finishTurn(input) { return serial(input, async () => { const value = await read(input, false); const message = value.messages.find(item => item.id === input.assistantMessageId && item.role === 'assistant'); if (!message) throw new ChatError('CHAT_MESSAGE_NOT_FOUND', 'Assistant message not found.', 404); if (message.status !== 'streaming') throw new ChatError('CHAT_TURN_NOT_STREAMING', 'This response is no longer streaming.'); message.content = input.content; message.status = 'completed'; message.usage = input.usage; message.error = null; value.updatedAt = new Date().toISOString(); await write(input, value); liveTurns.delete(input.assistantMessageId); }); },
    stopTurn(input) { return serial(input, async () => { const value = await read(input, false); const message = value.messages.find(item => item.id === input.assistantMessageId && item.role === 'assistant'); if (!message) throw new ChatError('CHAT_MESSAGE_NOT_FOUND', 'Assistant message not found.', 404); if (message.status !== 'streaming') return; message.content = input.content.slice(0, 64_000); message.status = input.error ? 'error' : 'stopped'; message.error = input.error?.slice(0, 500) ?? null; value.updatedAt = new Date().toISOString(); await write(input, value); liveTurns.delete(input.assistantMessageId); }); },
    createProposal(input) { return serial(input, async () => { const value = await read(input); const prior = value.proposals.find(item => item.requestId === input.proposal.requestId); if (prior) { if (prior.requestFingerprint !== input.proposal.requestFingerprint) throw new ChatError('CHAT_REQUEST_CONFLICT', 'This request ID already represents different proposal intent.'); return { proposal: prior, claimed: false }; } value.proposals.push(input.proposal); value.updatedAt = input.proposal.updatedAt; await write(input, value); liveProposals.add(input.proposal.id); return { proposal: input.proposal, claimed: true }; }); },
    updateProposal(input) { return serial(input, async () => { const value = await read(input), proposal = value.proposals.find(item => item.id === input.proposalId); if (!proposal) throw new ChatError('CHAT_PROPOSAL_NOT_FOUND', 'Shot edit proposal not found.', 404); if (!input.expected.includes(proposal.status)) throw new ChatError('CHAT_PROPOSAL_NOT_PENDING', 'This proposal is no longer pending.'); Object.assign(proposal, input.patch, { updatedAt: new Date().toISOString() }); value.updatedAt = proposal.updatedAt; await write(input, value); if (proposal.status !== 'inferring') liveProposals.delete(proposal.id); return proposal; }); },
  };
}
