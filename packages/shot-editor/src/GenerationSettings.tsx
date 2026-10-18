import { useId } from 'react';
import type { Draft, fieldErrors } from './editor-state.ts';
import type { CapabilityView } from './types.ts';

/** The editor owns these raw strings, including incomplete numeric input. */
export type GenerationSettingsValue = Draft['controls'];
export type GenerationSettingsKey = Exclude<keyof GenerationSettingsValue, 'modelId'>;
export type GenerationSettingsChange = <K extends GenerationSettingsKey>(
  key: K,
  value: GenerationSettingsValue[K],
) => void;
export interface GenerationSettingsProps {
  value: GenerationSettingsValue;
  onChange: GenerationSettingsChange;
  /** Only metadata for value.modelId is used; stale metadata is unknown. */
  capability?: CapabilityView | null;
  /** Pass fieldErrors(draft); validation/save authority stays with the editor. */
  errors?: ReturnType<typeof fieldErrors>;
}

export function GenerationSettings({ value, onChange, capability, errors = {} }: GenerationSettingsProps) {
  const id = useId();
  const model = capability?.modelId === value.modelId ? capability : undefined;
  const durations = model?.durations;
  const resolutions = model?.resolutions;
  const ratios = model?.aspectRatios;
  const ratioNote = !model ? undefined : ratios === undefined
    ? 'Aspect ratio support is unknown; no metadata was supplied.'
    : !ratios.length ? 'No aspect ratio options are listed. Your value is kept.'
      : ratios.includes(value.aspectRatio) ? undefined
        : `Aspect ratio is not listed for this model. Listed aspect ratios: ${ratios.join(', ')}.`;
  const audioNote = !model ? undefined : model.generateAudioSupported === false
    ? 'Audio generation is not supported by this model. Your audio setting is kept.'
    : model.generateAudioSupported === true ? undefined
      : 'Audio support is unknown; no metadata was supplied.';
  // Compare only for the catalog hint. Never parse or normalize the emitted draft.
  const durationListed = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.durationSeconds)
    && durations?.includes(Number(value.durationSeconds));
  const durationNote = !model ? undefined : !durations
    ? 'Duration support is unknown; no metadata was supplied.'
    : !durations.length ? 'No duration options are listed. Your value is kept.'
      : durationListed ? undefined : `Duration is not listed for this model. Listed durations: ${durations.join(', ')} seconds.`;
  const resolutionNote = !model ? undefined : !resolutions
    ? 'Resolution support is unknown; no metadata was supplied.'
    : !resolutions.length ? 'No resolution options are listed. Your value is kept.'
      : resolutions.includes(value.resolution) ? undefined
        : `Resolution is not listed for this model. Listed resolutions: ${resolutions.join(', ')}.`;
  const seedNote = !model ? undefined : model.seedSupported === false
    ? 'This model does not support a seed. Keep editing or clear it explicitly.'
    : model.seedSupported === true ? undefined : 'Seed support is unknown; no metadata was supplied.';
  const unknownId = `${id}-unknown`;
  return (
    <section className="fl-generation-settings" aria-label="Generation settings">
      <div className="fl-generation-settings__fields">
        <div className="fl-generation-settings__field">
          <label htmlFor={`${id}-duration`}>Duration (seconds)</label>
          <input id={`${id}-duration`} inputMode="decimal" value={value.durationSeconds}
            list={durations?.length ? `${id}-durations` : undefined}
            aria-invalid={!!errors.duration}
            aria-describedby={[
              errors.duration && `${id}-duration-error`,
              !model ? unknownId : durationNote && `${id}-duration-note`,
            ].filter(Boolean).join(' ') || undefined}
            onChange={(event) => onChange('durationSeconds', event.currentTarget.value)} />
          {!!durations?.length && <datalist id={`${id}-durations`}>
            {[...new Set(durations)].map((duration) => <option key={duration} value={String(duration)} />)}
          </datalist>}
        </div>
        <div className="fl-generation-settings__field">
          <label htmlFor={`${id}-resolution`}>Resolution</label>
          <input id={`${id}-resolution`} value={value.resolution}
            list={resolutions?.length ? `${id}-resolutions` : undefined}
            aria-describedby={!model ? unknownId : resolutionNote ? `${id}-resolution-note` : undefined}
            onChange={(event) => onChange('resolution', event.currentTarget.value)} />
          {!!resolutions?.length && <datalist id={`${id}-resolutions`}>
            {[...new Set(resolutions)].map((resolution) => <option key={resolution} value={resolution} />)}
          </datalist>}
        </div>
        <div className="fl-generation-settings__field">
          <label htmlFor={`${id}-ratio`}>Aspect ratio</label>
          <input id={`${id}-ratio`} value={value.aspectRatio}
            list={ratios?.length ? `${id}-ratios` : undefined}
            aria-describedby={!model ? unknownId : ratioNote ? `${id}-ratio-note` : undefined}
            onChange={(event) => onChange('aspectRatio', event.currentTarget.value)} />
          {!!ratios?.length && <datalist id={`${id}-ratios`}>
            {[...new Set(ratios)].map((ratio) => <option key={ratio} value={ratio} />)}
          </datalist>}
        </div>
        <div className="fl-generation-settings__field">
          <label htmlFor={`${id}-audio`}>Generate audio</label>
          <label className="fl-generation-settings__audio" htmlFor={`${id}-audio`}>
            <input id={`${id}-audio`} type="checkbox" checked={value.generateAudio}
              aria-describedby={!model ? unknownId : audioNote ? `${id}-audio-note` : undefined}
              onChange={(event) => onChange('generateAudio', event.currentTarget.checked)} />
            <span aria-hidden="true">{value.generateAudio ? 'On' : 'Off'}</span>
          </label>
        </div>
        <div className="fl-generation-settings__field fl-generation-settings__seed">
          <label htmlFor={`${id}-seed`}>Seed (optional)</label>
          <div className="fl-generation-settings__seed-entry">
            <input id={`${id}-seed`} inputMode="numeric" placeholder="Not set" value={value.seed}
              aria-invalid={!!errors.seed}
              aria-describedby={[
                errors.seed && `${id}-seed-error`,
                !model ? unknownId : seedNote && `${id}-seed-note`,
              ].filter(Boolean).join(' ') || undefined}
              onChange={(event) => onChange('seed', event.currentTarget.value)} />
            <button type="button" onClick={() => onChange('seed', '')} aria-label="Clear seed">Clear</button>
          </div>
        </div>
      </div>
      <div className="fl-generation-settings__notes">
        {errors.duration && <p className="fl-generation-settings__error" id={`${id}-duration-error`}>{errors.duration}</p>}
        {errors.seed && <p className="fl-generation-settings__error" id={`${id}-seed-error`}>{errors.seed}</p>}
        {durationNote && <p id={`${id}-duration-note`}>{durationNote}</p>}
        {resolutionNote && <p id={`${id}-resolution-note`}>{resolutionNote}</p>}
        {seedNote && <p id={`${id}-seed-note`}>{seedNote}</p>}
        {ratioNote && <p id={`${id}-ratio-note`}>{ratioNote}</p>}
        {audioNote && <p id={`${id}-audio-note`}>{audioNote}</p>}
        {!model && <p id={unknownId}>Setting support is unknown; no current metadata for this model. Your values are kept.</p>}
      </div>
    </section>
  );
}
