import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  createEditorState,
  editDraft,
  fieldErrors,
  finishSave,
  hasConflict,
  isDirty,
  receiveShot,
  reconcile,
  saveDraft,
  startSave,
} from './editor-state.ts';
import type { Draft, EditorState } from './editor-state.ts';
import type { AssetView, DraftFrameRef, DraftFrameReport, FrameRole, ShotEditorProps, ShotView } from './types.ts';
import { modelIssues } from './compatibility.ts';
import { ownedThumbnailUrl } from './media-url.ts';
import { ModelPicker } from './ModelPicker.tsx';
import { GenerationSettings } from './GenerationSettings.tsx';
import { PromptComposer } from './PromptComposer.tsx';

const frames = [
  {
    role: 'first_frame',
    key: 'firstFrameAssetId',
    label: 'Start frame',
    hint: 'Where the shot begins',
  },
  {
    role: 'last_frame',
    key: 'lastFrameAssetId',
    label: 'End frame',
    hint: 'Where the shot arrives',
  },
] as const;

function closeReference(reference: HTMLDetailsElement) {
  reference.open = false;
  reference.querySelector('summary')?.focus();
}

/** An import hint is only true while the frame it describes is still unsaved. */
const IMPORT_HINT = /^Imported .+\. Save changes to keep this (?:start|end) frame\.$/;

function retireImportNotes(
  notes: Partial<Record<FrameRole, string>>,
  revision: number,
): Partial<Record<FrameRole, string>> {
  const next: Partial<Record<FrameRole, string>> = {};
  for (const [role, note] of Object.entries(notes) as Array<[FrameRole, string]>) {
    next[role] = IMPORT_HINT.test(note) ? `Saved with the shot · revision ${revision}` : note;
  }
  return next;
}

export function ShotEditor(props: ShotEditorProps) {
  if (!props.shot)
    return (
      <section className="fl-shot-editor fl-shot-editor--empty" aria-label="Shot editor">
        <h2>Choose a shot</h2>
        <p>Open a shot, or create one in your project, to add a prompt and frames.</p>
      </section>
    );
  return (
    <ShotEditorSession
      key={`${props.shot.projectId}:${props.shot.id}`}
      {...props}
      shot={props.shot}
    />
  );
}

function ShotEditorSession({
  shot,
  assets,
  capabilities,
  busy = false,
  onSave,
  onUpload,
  onPrepare,
  onDirtyChange,
  onDraftChange,
  registerSave,
}: ShotEditorProps & { shot: ShotView }) {
  const id = useId();
  const [state, setState] = useState(() => createEditorState(shot));
  const live = useRef(state);
  const serial = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const roleEpoch = useRef<Record<FrameRole, number>>({ first_frame: 0, last_frame: 0 });
  const modelEpoch = useRef(0);
  const uploadTokens = useRef<Partial<Record<FrameRole, number>>>({});
  const [uploads, setUploads] = useState<Partial<Record<FrameRole, string>>>({});
  const [imports, setImports] = useState<AssetView[]>([]);
  const [uploadNotes, setUploadNotes] = useState<Partial<Record<FrameRole, string>>>({});
  const preparingRef = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const update = useCallback((fn: (current: EditorState) => EditorState) => {
    const previous = live.current;
    live.current = fn(previous);
    setState(live.current);
    // Queue the canonical buffer before notifying a synchronous external store.
    // Report every draft edit (even while dirty), plus save/reconcile transitions.
    if (live.current.draft !== previous.draft || isDirty(live.current) !== isDirty(previous)) {
      onDirtyChange?.(isDirty(live.current), shot.id);
    }
  }, [onDirtyChange, shot.id]);
  useLayoutEffect(() => {
    update((current) => receiveShot(current, shot));
  }, [shot, update]);
  const dirty = isDirty(state);
  const conflict = hasConflict(state);
  const change = (draft: Draft) => update((current) => editDraft(current, draft));
  const { draft } = state;
  const inputErrors = fieldErrors(draft);
  const invalid = Object.keys(inputErrors).length > 0;
  const setControl = <K extends keyof Draft['controls']>(key: K, value: Draft['controls'][K]) => {
    if (key === 'modelId') modelEpoch.current++;
    change({ ...live.current.draft, controls: { ...live.current.draft.controls, [key]: value } });
  };
  const setFrame = (role: FrameRole, value: string | null) => {
    roleEpoch.current[role]++;
    const key = role === 'first_frame' ? 'firstFrameAssetId' : 'lastFrameAssetId';
    change({ ...live.current.draft, bindings: { ...live.current.draft.bindings, [key]: value } });
  };
  async function save() {
    if (
      busy ||
      preparingRef.current ||
      Object.keys(uploadTokens.current).length ||
      live.current.saving ||
      hasConflict(live.current) ||
      !isDirty(live.current) ||
      Object.keys(fieldErrors(live.current.draft)).length
    )
      return;
    const token = ++serial.current;
    const request = saveDraft(live.current);
    update((current) => startSave(current, token));
    setError('');
    try {
      const result = await onSave(request);
      if (mounted.current) update((current) => finishSave(current, token, result));
      // The imported frame is persisted now; an instruction to save it would be stale.
      if (mounted.current) setUploadNotes((current) => retireImportNotes(current, result.revision));
    } catch (cause) {
      if (!mounted.current) return;
      const failure =
        cause && typeof cause === 'object'
          ? (cause as { currentRevision?: unknown; message?: unknown })
          : {};
      if (
        typeof failure.currentRevision === 'number' &&
        Number.isSafeInteger(failure.currentRevision) &&
        failure.currentRevision > live.current.base.revision
      ) {
        update((current) => ({
          ...current,
          saving: null,
          conflictRevision: failure.currentRevision as number,
        }));
      } else {
        update((current) => ({ ...current, saving: null }));
        setError(
          `Save not confirmed. Your edits are still here. ${typeof failure.message === 'string' ? failure.message : 'Check the workspace before retrying; the write may have reached the server.'}`,
        );
      }
    }
  }
  const images = [
    ...new Map(
      [...imports, ...assets]
        .filter((asset) => asset.kind === 'image' && asset.projectId === shot.projectId)
        .map((asset) => [asset.id, asset]),
    ).values(),
  ];
  const issues = modelIssues(draft, capabilities, images);
  const uploading = Object.keys(uploads).length > 0;
  const working = busy || !!state.saving || preparing;
  // An adjacent surface gets the editor's own guarded save, never a second write
  // path: the registered action runs the same dirty/upload/conflict/error checks.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    registerSave?.(() => {
      void saveRef.current();
    });
    return () => registerSave?.(null);
  }, [registerSave]);
  // Publish draft references only when they actually change; the report is a
  // presentation fact and never advances a save, review or approval.
  const reportedDraft = useRef('');
  useEffect(() => {
    if (!onDraftChange) return;
    const describe = (key: 'firstFrameAssetId' | 'lastFrameAssetId'): DraftFrameRef | null => {
      const assetId = draft.bindings[key];
      if (!assetId) return null;
      const asset = images.find((item) => item.id === assetId);
      return { assetId, filename: asset?.filename ?? assetId, mediaUrl: asset?.mediaUrl ?? '' };
    };
    const report: DraftFrameReport = {
      shotId: shot.id,
      first: describe('firstFrameAssetId'),
      last: describe('lastFrameAssetId'),
    };
    const key = JSON.stringify(report);
    if (key === reportedDraft.current) return;
    reportedDraft.current = key;
    onDraftChange(report);
  }, [draft.bindings, images, onDraftChange, shot.id]);
  async function upload(role: FrameRole, file: File) {
    if (busy || live.current.saving || preparingRef.current) return;
    const epoch = ++roleEpoch.current[role];
    if (
      (!['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(file.type) &&
        !(file.type === '' && /\.(png|jpe?g|webp|avif)$/i.test(file.name))) ||
      file.size === 0 ||
      file.size > 20 * 1024 * 1024
    ) {
      setUploadNotes((current) => ({
        ...current,
        [role]:
          'Choose a PNG, JPEG, WebP or AVIF image up to 20 MiB. The server checks the file contents before importing.',
      }));
      return;
    }
    const token = ++serial.current;
    const model = modelEpoch.current;
    const expectedRevision = live.current.base.revision;
    uploadTokens.current[role] = token;
    setUploads((current) => ({ ...current, [role]: file.name }));
    setUploadNotes((current) => ({ ...current, [role]: '' }));
    try {
      const asset = await onUpload({
        projectId: shot.projectId,
        shotId: shot.id,
        expectedRevision,
        role,
        file,
      });
      if (!mounted.current) return;
      if (asset.projectId !== shot.projectId || asset.kind !== 'image')
        throw new Error('The imported file is not an owned image in this project.');
      setImports((current) => [...current.filter((item) => item.id !== asset.id), asset]);
      if (uploadTokens.current[role] !== token) return;
      if (
        roleEpoch.current[role] !== epoch ||
        modelEpoch.current !== model ||
        live.current.base.revision !== expectedRevision ||
        hasConflict(live.current)
      ) {
        setUploadNotes((current) => ({
          ...current,
          [role]: `Imported ${asset.filename} but did not attach it because the shot or reference changed. Choose it from the image list if needed.`,
        }));
        return;
      }
      setFrame(role, asset.id);
      setUploadNotes((current) => ({
        ...current,
        [role]: `Imported ${asset.filename}. Save changes to keep this ${role === 'first_frame' ? 'start' : 'end'} frame.`,
      }));
    } catch (cause) {
      if (mounted.current && uploadTokens.current[role] === token)
        setUploadNotes((current) => ({
          ...current,
          [role]:
            cause instanceof Error
              ? cause.message
              : 'Import not confirmed. Your existing frame has not changed.',
        }));
    } finally {
      if (mounted.current && uploadTokens.current[role] === token) {
        delete uploadTokens.current[role];
        setUploads((current) => {
          const next = { ...current };
          delete next[role];
          return next;
        });
      }
    }
  }
  async function prepare() {
    if (
      busy ||
      preparingRef.current ||
      live.current.saving ||
      Object.keys(uploadTokens.current).length ||
      isDirty(live.current) ||
      hasConflict(live.current) ||
      Object.keys(fieldErrors(live.current.draft)).length
    )
      return;
    preparingRef.current = true;
    setPreparing(true);
    setError('');
    try {
      await onPrepare({
        projectId: shot.projectId,
        shotId: shot.id,
        expectedRevision: live.current.base.revision,
      });
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Review could not be prepared. No generation was submitted.',
        );
    } finally {
      if (mounted.current) {
        preparingRef.current = false;
        setPreparing(false);
      }
    }
  }
  return (
    <section className="fl-shot-editor" aria-label="Shot editor">
      <header className="fl-shot-editor__header">
        <label className="fl-shot-editor__title" htmlFor={`${id}-title`}>
          Shot
          <input
            id={`${id}-title`}
            value={draft.title}
            onChange={(event) => change({ ...live.current.draft, title: event.target.value })}
          />
        </label>
        <span className="fl-shot-editor__save-status" role="status">
          {state.saving
            ? 'Saving… You can keep editing.'
            : dirty
              ? 'Unsaved changes'
              : `Saved revision ${state.base.revision}`}
        </span>
      </header>
      <div className="fl-shot-editor__frames" role="group" aria-label="Frame references">
        {frames.map((frame) => {
          const asset = images.find((item) => item.id === draft.bindings[frame.key]);
          // Only owned media may become a thumbnail request; a refused URL is never
          // handed to <img src>, and the binding, filename and saved state survive.
          const thumbnailUrl = asset ? ownedThumbnailUrl(asset.mediaUrl) : undefined;
          return (
            <section
              className="fl-shot-editor__frame"
              key={frame.role}
              aria-labelledby={`${id}-${frame.role}-heading`}
            >
              <details
                className="fl-shot-editor__reference"
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || event.defaultPrevented || !event.currentTarget.open) return;
                  event.preventDefault();
                  event.stopPropagation();
                  closeReference(event.currentTarget);
                }}
              >
                <summary className="fl-shot-editor__reference-summary" aria-label={`${frame.label} reference`}>
                  <div className="fl-shot-editor__image">
                    {asset && thumbnailUrl ? (
                      <img src={thumbnailUrl} alt={`${frame.label}: ${asset.filename}`} />
                    ) : asset ? (
                      <span
                        className="fl-shot-editor__image-empty"
                        role="img"
                        aria-label={`Reference preview unavailable: ${asset.filename}`}
                      >
                        ⊘
                      </span>
                    ) : (
                      <span className="fl-shot-editor__image-empty" aria-hidden="true">＋</span>
                    )}
                  </div>
                  <div className="fl-shot-editor__frame-heading">
                    <h3 id={`${id}-${frame.role}-heading`}>{frame.label}</h3>
                    <span>
                      {asset ? asset.filename : draft.bindings[frame.key]
                        ? `Unavailable image: ${draft.bindings[frame.key]}` : frame.hint}
                    </span>
                    <small>{asset && !thumbnailUrl
                      ? 'Preview unavailable · not shown'
                      : draft.bindings[frame.key] ? 'Edit reference' : 'Choose or upload an image'}</small>
                  </div>
                  <span className="fl-shot-editor__reference-toggle" aria-hidden="true">⌄</span>
                </summary>
                <div className="fl-shot-editor__frame-controls">
                  {asset && (
                    <p className="fl-shot-editor__file">
                      <strong>{asset.filename}</strong>
                      <span>
                        {asset.width} × {asset.height} ·{' '}
                        {asset.origin === 'sample'
                          ? 'Sample image'
                          : asset.origin === 'imported'
                            ? 'Imported image'
                            : 'Generated image'}
                      </span>
                    </p>
                  )}
                  <label htmlFor={`${id}-${frame.role}-asset`}>{frame.label} image</label>
                  <select
                    id={`${id}-${frame.role}-asset`}
                    value={draft.bindings[frame.key] ?? ''}
                    onChange={(event) => setFrame(frame.role, event.target.value || null)}
                  >
                    <option value="">No {frame.label.toLowerCase()}</option>
                    {!asset && draft.bindings[frame.key] !== null && (
                      <option value={draft.bindings[frame.key]!}>
                        Unavailable image: {draft.bindings[frame.key]}
                      </option>
                    )}
                    {images.map((image) => (
                      <option key={image.id} value={image.id}>
                        {image.filename}
                      </option>
                    ))}
                  </select>
                  <div className="fl-shot-editor__frame-actions">
                    <label className="fl-shot-editor__upload" htmlFor={`${id}-${frame.role}-upload`}>
                      Upload {frame.label.toLowerCase()}
                      <input
                        id={`${id}-${frame.role}-upload`}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/avif"
                        disabled={working}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = '';
                          if (file) void upload(frame.role, file);
                        }}
                      />
                    </label>
                    <button type="button" onClick={() => setFrame(frame.role, null)}>
                      Clear {frame.label.toLowerCase()}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => closeReference(event.currentTarget.closest('details')!)}
                    >
                      Close {frame.label.toLowerCase()} picker
                    </button>
                  </div>
                </div>
              </details>
              {uploads[frame.role] && (
                <p className="fl-shot-editor__upload-note" aria-live="polite">Importing {uploads[frame.role]}… You can keep editing.</p>
              )}
              {uploadNotes[frame.role] && (
                <p className="fl-shot-editor__upload-note" aria-live="polite">
                  {uploadNotes[frame.role]}
                </p>
              )}
            </section>
          );
        })}
      </div>
      <div className="fl-shot-editor__intent">
        <PromptComposer
          value={draft.prompt}
          onChange={(prompt) => change({ ...live.current.draft, prompt })}
        />
        <div className="fl-shot-editor__creator-settings">
          <ModelPicker
            value={draft.controls.modelId}
            capabilities={capabilities}
            onChange={(modelId) => setControl('modelId', modelId)}
          />
          <GenerationSettings
            value={draft.controls}
            capability={capabilities.find((model) => model.modelId === draft.controls.modelId)}
            errors={inputErrors}
            onChange={setControl}
          />
        </div>
      </div>
      {conflict && (
        <div className="fl-shot-editor__notice" role="alert">
          <p>This shot changed elsewhere. Your edits are still here.</p>
          {state.latest.revision < (state.conflictRevision ?? 0) ? (
            <p>
              Refresh the workspace to load revision {state.conflictRevision} before choosing which
              edits to keep.
            </p>
          ) : (
            <>
              <details>
                <summary>Latest saved shot · revision {state.latest.revision}</summary>
                <p>{state.latest.title}</p>
                <pre>{state.latest.prompt}</pre>
                <pre>
                  {JSON.stringify(
                    { controls: state.latest.controls, bindings: state.latest.bindings },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <div className="fl-shot-editor__conflict-actions">
                <button
                  type="button"
                  disabled={working || uploading}
                  onClick={() => {
                    modelEpoch.current++;
                    setError('');
                    update((current) => reconcile(current, true));
                  }}
                >
                  Keep my edits against revision {state.latest.revision}
                </button>
                <button
                  type="button"
                  disabled={working || uploading}
                  onClick={() => {
                    modelEpoch.current++;
                    setError('');
                    update((current) => reconcile(current, false));
                  }}
                >
                  Use latest saved shot
                </button>
              </div>
              <small>
                Keeping your edits replaces the latest shot settings when you save. Using the saved
                shot discards your local edits.
              </small>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="fl-shot-editor__notice" role="alert">
          {error}
        </p>
      )}
      <footer className="fl-shot-editor__footer">
        <p id={`${id}-review-help`}>
          {uploading
            ? 'Wait for the image import before saving or reviewing.'
            : dirty
              ? 'Save your changes before reviewing a generation.'
              : issues.length
                ? 'Review these blockers with the exact saved shot. No generation will be sent.'
                : 'Review the exact request before generating. Nothing is submitted yet.'}
        </p>
        <div className="fl-shot-editor__footer-actions">
          <button
            type="button"
            disabled={working || uploading || conflict || !dirty || invalid}
            onClick={() => void save()}
          >
            {state.saving ? 'Saving…' : 'Save changes'}
          </button>
          <button
            className="fl-shot-editor__primary"
            type="button"
            aria-describedby={`${id}-review-help`}
            disabled={working || uploading || conflict || dirty || invalid}
            onClick={() => void prepare()}
          >
            {preparing ? 'Preparing review…' : 'Review generation'}
          </button>
        </div>
      </footer>
      <section className="fl-shot-editor__compatibility" aria-label="Model compatibility">
        <h3>{issues.length ? 'Before you generate' : 'Frame settings are compatible'}</h3>
        {issues.length ? (
          <ul>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : (
          <p>
            The current catalog supports these frames, duration and resolution. The exact request
            and account access are checked again at review.
          </p>
        )}
        {issues.length > 0 && (
          <p>You can keep editing and save this draft without changing its intent.</p>
        )}
      </section>
    </section>
  );
}
