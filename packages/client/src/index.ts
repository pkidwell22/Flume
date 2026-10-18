import {
  AgentCommandSchema, ApiErrorSchema, AssetSchema, CommandSchema, CommandReceiptSchema, IdSchema, ProjectSchema, WorkspaceSchema,
  type AgentCommand, type Asset, type Command, type CommandReceipt, type Project, type Workspace,
} from '@flume/domain';

export interface FlumeClientOptions {
  /** Server origin, not an /api path. Browser clients should use createBrowserClient. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export interface RequestOptions { signal?: AbortSignal }
interface Parser<T> { parse(input: unknown): T }

export class FlumeClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly currentRevision: number | undefined;
  readonly details: unknown;
  /** A dispatched write may have succeeded. Read state / replay the SAME command ID; never mint a retry ID. */
  readonly outcomeUnknown: boolean;
  constructor(code: string, message: string, options: { status?: number; currentRevision?: number; details?: unknown; outcomeUnknown?: boolean } = {}) {
    super(message); this.name = 'FlumeClientError'; this.code = code;
    this.status = options.status; this.currentRevision = options.currentRevision;
    this.details = options.details; this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

function limit(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError(`Invalid ${name}`);
  return value;
}
function origin(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new TypeError('baseUrl must be an HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('baseUrl must be an HTTP(S) origin without credentials, query or path');
  }
  if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new TypeError('Remote servers require HTTPS');
  }
  return url;
}
async function readJson(response: Response, maxBytes: number, mutation: boolean): Promise<unknown> {
  const tooLarge = () => new FlumeClientError('response_too_large', 'API response exceeds the configured limit', { status: response.status, outcomeUnknown: mutation });
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw tooLarge(); }
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new FlumeClientError('invalid_response', 'API did not return JSON', { status: response.status, outcomeUnknown: mutation });
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FlumeClientError('invalid_response', 'API returned an empty response', { status: response.status, outcomeUnknown: mutation });
  let size = 0; let text = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw tooLarge(); }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); } catch {
    throw new FlumeClientError('invalid_response', 'API returned invalid JSON', { status: response.status, outcomeUnknown: mutation });
  }
}

/** Headless/agent client. Authorization is always enforced by the server. */
export class FlumeClient {
  protected readonly baseUrl: URL;
  protected readonly fetcher: typeof globalThis.fetch;
  protected credentials: RequestCredentials = 'omit';
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  constructor(options: FlumeClientOptions = {}) {
    this.baseUrl = origin(options.baseUrl ?? 'http://127.0.0.1:4311');
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = limit(options.timeoutMs ?? 30_000, 'timeoutMs', 300_000);
    this.maxResponseBytes = limit(options.maxResponseBytes ?? 8 * 1024 * 1024, 'maxResponseBytes', 64 * 1024 * 1024);
  }
  protected async request<T>(path: string, schema: Parser<T>, init: RequestInit = {}): Promise<T> {
    if (init.signal?.aborted) throw new FlumeClientError('aborted', 'Request was cancelled before dispatch');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    const mutation = init.method === 'POST';
    try {
      const response = await this.fetcher(new URL(path, this.baseUrl), { ...init, signal, credentials: this.credentials, redirect: 'error', headers: { accept: 'application/json', ...init.headers } });
      const body = await readJson(response, this.maxResponseBytes, mutation);
      if (!response.ok) {
        const parsed = ApiErrorSchema.safeParse(body);
        if (!parsed.success) throw new FlumeClientError('invalid_response', 'API returned an invalid error', { status: response.status, outcomeUnknown: mutation });
        const error = parsed.data;
        throw new FlumeClientError(error.code, error.message, {
          status: response.status, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
          details: error.details, outcomeUnknown: mutation && response.status >= 500,
        });
      }
      try { return schema.parse(body); } catch {
        throw new FlumeClientError('invalid_response', 'API response does not match the public contract', { status: response.status, outcomeUnknown: mutation });
      }
    } catch (error) {
      if (error instanceof FlumeClientError) throw error;
      const code = init.signal?.aborted ? 'aborted' : deadline.signal.aborted ? 'timeout' : 'network_error';
      throw new FlumeClientError(code, code === 'network_error' ? 'Could not read the API response' : 'Request was cancelled or timed out', { outcomeUnknown: mutation });
    } finally { clearTimeout(timer); }
  }
  listProjects(options: RequestOptions = {}): Promise<Project[]> {
    return this.request('/api/projects', ProjectSchema.array(), { ...options });
  }
  getWorkspace(projectId?: string, options: RequestOptions = {}): Promise<Workspace> {
    const query = projectId === undefined ? '' : `?${new URLSearchParams({ projectId: IdSchema.parse(projectId) })}`;
    return this.request(`/api/workspace${query}`, WorkspaceSchema, { ...options });
  }
  async command(command: AgentCommand, options: RequestOptions = {}): Promise<CommandReceipt> {
    if ((command as { type?: unknown })?.type === 'generation.approve') {
      throw new FlumeClientError('approval_requires_operator', 'Approve the exact review in the operator workspace; headless clients cannot approve');
    }
    const result = AgentCommandSchema.safeParse(command);
    if (!result.success) throw new FlumeClientError('invalid_command', 'Command does not match the public contract');
    return this.sendCommand(result.data, options);
  }
  protected async sendCommand(command: Command, options: RequestOptions): Promise<CommandReceipt> {
    const receipt = await this.request('/api/commands', CommandReceiptSchema, {
      ...options, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
    });
    if (receipt.commandId !== command.commandId || ('projectId' in command && receipt.projectId !== command.projectId)) {
      throw new FlumeClientError('receipt_mismatch', 'API returned a receipt for a different command or project', { outcomeUnknown: true });
    }
    return receipt;
  }
  async uploadAsset(projectId: string, file: Blob, filename = file instanceof File ? file.name : 'upload', options: RequestOptions = {}): Promise<Asset> {
    if (!IdSchema.safeParse(projectId).success || !(file instanceof Blob) || file.size <= 0 || file.size > MAX_UPLOAD_BYTES || !filename || filename.length > 255 || /[\/\\\x00-\x1f\x7f]/.test(filename) || filename === '.' || filename === '..') {
      throw new FlumeClientError('invalid_upload', 'Upload requires a non-empty bounded local file and a plain filename');
    }
    const form = new FormData(); form.set('projectId', projectId); form.set('file', file, filename);
    const asset = await this.request('/api/assets', AssetSchema, { ...options, method: 'POST', body: form });
    // Both IDs passed the platform UUID schema; PostgreSQL may return lowercase hex.
    // Compare identity without rewriting the caller's multipart field or returned asset.
    if (asset.projectId.toLowerCase() !== projectId.toLowerCase()) throw new FlumeClientError('asset_project_mismatch', 'API returned an asset for a different project', { outcomeUnknown: true });
    return asset;
  }
}

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

class BrowserClient extends FlumeClient {
  constructor(options: FlumeClientOptions) { super(options); this.credentials = 'same-origin'; }
  override async command(command: Command, options: RequestOptions = {}): Promise<CommandReceipt> {
    const parsed = CommandSchema.safeParse(command);
    if (!parsed.success) throw new FlumeClientError('invalid_command', 'Command does not match the public contract');
    return this.sendCommand(parsed.data, options);
  }
}
export type BrowserFlumeClient = BrowserClient;
/** Convenience, NOT proof of human identity. Server session/Host/Origin authorization remains mandatory. */
export function createBrowserClient(options: Omit<FlumeClientOptions, 'baseUrl'> = {}): BrowserFlumeClient {
  if (typeof window === 'undefined') throw new FlumeClientError('browser_required', 'Use FlumeClient in headless clients; operator sessions belong in the browser');
  return new BrowserClient({ ...options, baseUrl: window.location.origin });
}
