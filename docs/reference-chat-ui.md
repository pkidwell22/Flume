# Reference chat UI

Project chat accepts one local image or video at a time from the file picker, paste, or drag and drop. Files larger than 32 MiB and non-image/video files are rejected in the browser. Pasted remote URLs are never fetched; the UI asks the operator to download the media first.

Uploads use `ChatPort.uploadReference(projectId, file)` and are followed by `onWorkspaceRefresh()`. Selection is accepted only after that authoritative project readback and only if the project and conversation are still current. Up to four owned assets can be selected. Registered visual Ollama models (`ollama/kimi-k3` by default and optional `ollama/gemma4:31b`) allow images or one video plus optional stills. Other models retain the existing image metadata-only behavior and cannot select video. Videos are represented by verified, downscaled sampled frames; audio and native raw MP4 bytes are not sent to the model.

The video label says that sampled frames are analyzed. It does not claim that the raw video or audio is forwarded. Completed assistant messages render the durable `recordedContext.references` summary, including sampled frame count, source frame count, normalized timestamps, and “audio not analyzed.”

“Use analysis for shot edit” passes the completed assistant message ID as `sourceMessageId`. The proposal copy identifies this as saved analysis text and recorded provenance; applying remains a separate revision-checked action and never starts generation.

For an owned video, first- and last-frame extraction call `ChatPort.extractReferenceFrame({ projectId, assetId, frame })`. The returned image is shown as available for an explicit “Use as … frame in saved shot” action only after authoritative refresh. The parent callback receives the shot ID and expected saved revision. Dirty, uncertain, busy, stale, or navigated-away state blocks or discards the action. Extraction and binding do not prepare or start generation.

## Added interfaces

Optional `ChatPort` methods preserve existing test fixtures and embedders:

```ts
uploadReference?(projectId: string, file: File): Promise<Asset>;
extractReferenceFrame?(input: {
  projectId: string;
  assetId: string;
  frame: 'first' | 'last';
}): Promise<Asset>;
```

`ChatPort.propose` accepts optional `sourceMessageId?: string`.

`ChatPanel` accepts:

```ts
onWorkspaceRefresh?: () => Promise<void>;
onUseReferenceFrame?: (input: {
  assetId: string;
  frame: 'first' | 'last';
  shotId: string;
  expectedRevision: number;
}) => Promise<void>;
```

`ChatMessage` accepts optional `recordedContext.references: VisualReference[]`, using the frozen visual-reference provenance shape.
