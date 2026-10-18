export type FrameRole = 'first_frame' | 'last_frame';

/** Structural subset of the domain Shot. No browser code imports this server package. */
export interface VideoIntent {
  prompt: string;
  controls: {
    modelId: string;
    durationSeconds: number;
    resolution: string;
    aspectRatio: string;
    generateAudio: boolean;
    seed?: number;
  };
  bindings: {firstFrameAssetId: string | null; lastFrameAssetId: string | null};
}

/** Media preparation resolves owned assets; this package never reads/uploads files. */
export interface ResolvedFrame {assetId: string; url: string}
export interface ResolvedFrames {firstFrame: ResolvedFrame | null; lastFrame: ResolvedFrame | null}

export interface VideoCapability {
  modelId: string;
  name: string;
  durations: readonly number[];
  resolutions: readonly string[];
  aspectRatios: readonly string[];
  frameRoles: readonly FrameRole[];
  seedSupported: boolean;
  generateAudioSupported: boolean;
  availability: 'available' | 'blocked' | 'unknown';
  blocker: string | null;
}

export interface VideoBody {
  readonly model: string;
  readonly prompt: string;
  readonly duration: number;
  readonly resolution: string;
  readonly aspect_ratio: string;
  readonly generate_audio: boolean;
  readonly seed?: number;

  readonly frame_images?: readonly {
    readonly type: 'image_url';
    readonly image_url: {readonly url: string};
    readonly frame_type: FrameRole;
  }[];
}

export interface CompiledVideoRequest {
  readonly provider: 'openrouter';
  readonly modelId: string;
  readonly body: VideoBody;
  /** The UTF-8 string actually sent on the wire. Persist it with the review. */
  readonly bodyJson: string;
  readonly bodySha256: string;
}

export interface VideoReceipt {
  readonly provider: 'openrouter';
  readonly modelId: string;
  readonly jobId: string;
  readonly bodySha256: string;
}
export interface ProviderProblem {
  code: string;
  message: string;
  retryable: boolean;
  httpStatus: number | null;
  providerCode: string | null;
  nextAction: 'edit_request' | 'configure_provider' | 'resolve_privacy_route' | 'check_status' | 'hold';
  excludedEndpointCount?: number;
}
export type SubmitResult =
  | {status: 'accepted'; receipt: VideoReceipt}
  | {status: 'blocked' | 'failed' | 'acceptance_unknown'; error: ProviderProblem; receipt?: VideoReceipt};

export interface VideoPrivacyPolicy {
  /** Explicit application-wide ZDR requirement, not inferred from one model's rejection. */
  zdrRequired?: boolean;
  /** Persisted model-specific privacy rejection observations, supplied by the server. */
  privacyBlockedModelIds?: readonly string[];
}

export interface OpenRouterVideoOptions extends VideoPrivacyPolicy {
  /** Supplied only by server configuration. Never read from environment in this package. */
  getApiKey: () => string | undefined;
  fetch: typeof globalThis.fetch;
  baseUrl?: string;
  allowLoopbackHttpForTests?: boolean;

  /** Deadline covers headers AND the complete JSON body. Hard ceiling: 120 seconds. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  /** Streamed content budget, independent of JSON limits. Default and ceiling: 512 MiB. */
  maxContentBytes?: number;
  /** One deadline for content headers and complete stream (including backpressure). Default/ceiling: 120 seconds. */
  contentTimeoutMs?: number;
}
export interface ProviderCallOptions {signal?: AbortSignal}

/** Only bytes and validated metadata cross into owned-media import, never URLs or credentials. */
export interface VideoContent {
  mimeType: 'video/mp4';
  body: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}
export type VideoContentResult<T> =
  | {status: 'read'; receipt: VideoReceipt; output: RemoteVideoOutput; value: T}
  | {status: 'content_unavailable'; receipt: VideoReceipt | null; output: RemoteVideoOutput | null; error: ProviderProblem};

export type DiscoveryResult = {status: 'ok'; capabilities: VideoCapability[]} | {status: 'unavailable'; error: ProviderProblem};
export type RemoteVideoOutput = {kind: 'openrouter_content'; jobId: string; index: number};
export type VideoStatusResult =
  | {status: 'queued' | 'running'; receipt: VideoReceipt; providerStatus: 'pending' | 'in_progress'}
  | {status: 'retrieving'; receipt: VideoReceipt; providerStatus: 'completed'; outputs: RemoteVideoOutput[]; costUsd: string | null}
  | {status: 'failed' | 'blocked' | 'status_unavailable'; receipt: VideoReceipt | null; error: ProviderProblem; providerStatus?: string};

/** Worker owns persistence, dispatch fencing, polling cadence and owned-media publication. */
export interface OpenRouterVideoPort {
  discoverModels(call?: ProviderCallOptions): Promise<DiscoveryResult>;
  submit(request: CompiledVideoRequest, call?: ProviderCallOptions): Promise<SubmitResult>;
  status(receipt: VideoReceipt, call?: ProviderCallOptions): Promise<VideoStatusResult>;
  /**
   * Scoped, single-use stream handoff. The trusted consumer must await complete ingestion
   * and its cleanup; it must not detach work or retain body. Its promise is deliberately
   * awaited (not timeout-raced) so owned-media writes cannot outlive this method.
   * contentTimeoutMs bounds headers/stream, not post-EOF media inspection. The media
   * consumer must enforce its own bounded inspection and publication/ownership fences.
   */
  readContent<T>(receipt: VideoReceipt, output: RemoteVideoOutput,
    consume: (content: VideoContent) => Promise<T>, call?: ProviderCallOptions): Promise<VideoContentResult<T>>;
}
