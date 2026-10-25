import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { CapabilityView, ShotControls, ShotEditorProps } from './types.ts';
import { useAnchoredPopup } from './useAnchoredPopup.ts';

export interface ModelPickerProps {
  value: ShotControls['modelId'];
  capabilities: ShotEditorProps['capabilities'];
  /** The parent owns busy policy; the picker performs no asynchronous operations. */
  disabled?: boolean;
  /** Change draft model identity only. Do not reset other controls or frame roles. */
  onChange: (nextModelId: ShotControls['modelId']) => void;
}

function routeLabel(model: CapabilityView): string {
  if (model.availability === 'blocked') return 'Route unavailable';
  if (model.availability === 'unknown') return 'Route not verified';
  return 'Route available';
}

function routeNote(model: CapabilityView): string {
  if (model.blocker) return model.blocker;
  if (model.availability === 'unknown')
    return 'Access has not been verified. Review before generation. Choose a route that reads Route available, or ask whoever runs this Flume build to confirm provider access. This only sets intent; nothing is sent.';
  return 'This route is currently unavailable. You can keep editing this draft.';
}

function frameLabel(role: string): string {
  if (role === 'first_frame') return 'Start frame';
  if (role === 'last_frame') return 'End frame';
  return role;
}

/**
 * A controlled draft chooser, not a generation/entitlement gate. Blocked and
 * unknown routes remain selectable as intent. Import model-picker.css after
 * the shot editor styles, alongside the existing Flume theme.
 */
export function ModelPicker({ value, capabilities, disabled = false, onChange }: ModelPickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(value);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const focusAfterBusy = useRef(false);

  useAnchoredPopup(open, trigger, panel, () => {
    focused.current = false;
    focusAfterBusy.current = false;
    setOpen(false);
  });

  useLayoutEffect(() => {
    if (open) search.current?.focus();
  }, [open]);

  // Native disabling may blur the initiating control before the next layout.
  // Remember ownership, but never restore focus after an outside interaction.
  useLayoutEffect(() => {
    if (disabled) {
      focusAfterBusy.current = focused.current || !!root.current?.contains(document.activeElement);
      focused.current = false;
      setOpen(false);
    } else if (focusAfterBusy.current) {
      focusAfterBusy.current = false;
      if (document.activeElement === document.body || document.activeElement === trigger.current) {
        trigger.current?.focus();
      }
    }
  }, [disabled]);

  useEffect(() => {
    if (!open && !disabled) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        focused.current = false;
        focusAfterBusy.current = false;
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
    };
  }, [open, disabled]);

  const selected = capabilities.find((model) => model.modelId === value);
  // Normalize search text only. Selected and returned IDs always remain literal.
  const words = query.trim().toLowerCase().split(/\s+/);
  const results = capabilities.filter((model) => {
    const text = [
      model.name, model.modelId, routeLabel(model), model.blocker,
      ...model.durations.map((duration) => `${duration} s`),
      ...model.resolutions, ...model.frameRoles.map(frameLabel),
      model.seedSupported ? 'seed supported' : 'seed not supported',
    ].join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const activeIndex = Math.max(0, results.findIndex((model) => model.modelId === activeId));
  const active = results[activeIndex];

  const show = () => {
    if (disabled) return;
    setQuery('');
    setActiveId(value);
    setOpen(true);
  };
  const choose = (modelId: string) => {
    if (disabled) return;
    setOpen(false);
    trigger.current?.focus();
    if (modelId !== value) onChange(modelId);
  };
  useLayoutEffect(() => {
    if (!open || !active) return;
    const option = document.getElementById(`${id}-option-${activeIndex}`);
    const list = option?.parentElement;
    if (!option || !list) return;
    const item = option.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    // Scroll only the results, never the focused search or an editor ancestor.
    // Oversized options start at their name rather than exposing only the tail.
    if (item.top < viewport.top || item.height > viewport.height) {
      list.scrollTop += item.top - viewport.top;
    } else if (item.bottom > viewport.bottom) {
      list.scrollTop += item.bottom - viewport.bottom;
    }
  }, [open, id, activeIndex, active?.modelId]);

  return (
    <div
      ref={root}
      className="fl-model-picker"
      onFocusCapture={() => { focused.current = true; }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          if (!disabled || event.relatedTarget) focused.current = false;
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <label id={`${id}-label`} className="fl-model-picker__label" htmlFor={`${id}-trigger`}>
        Model
      </label>
      <button
        ref={trigger}
        id={`${id}-trigger`}
        type="button"
        value={value}
        className="fl-model-picker__trigger"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-selected-name ${id}-current ${id}-help`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : show()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            show();
          }
        }}
      >
        <strong id={`${id}-selected-name`}>
          {selected?.name || (value ? 'Unlisted model' : 'Choose a model')}
        </strong>
        <span id={`${id}-current`} className="fl-model-picker__current">
          {value && <span className="fl-model-picker__literal">{value}</span>}
          <span className="fl-model-picker__route" data-route={selected?.availability ?? 'unknown'}>
            {selected ? routeLabel(selected) : value ? 'Not in catalog' : 'No model selected'}
          </span>
        </span>
        <svg className="fl-model-picker__chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div ref={panel} popover="manual" id={`${id}-panel`} role="dialog" aria-label="Choose a model" className="fl-model-picker__panel fl-anchored-popup">
          <div className="fl-model-picker__search-row">
            <input
              ref={search}
              className="fl-model-picker__search"
              role="combobox"
              aria-label="Search models"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${id}-results`}
              aria-describedby={`${id}-keys`}
              aria-activedescendant={active ? `${id}-option-${activeIndex}` : undefined}
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder="Search names, IDs or support"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveId(null);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (results.length) {
                    const step = event.key === 'ArrowDown' ? 1 : -1;
                    setActiveId(results[(activeIndex + step + results.length) % results.length]!.modelId);
                  }
                } else if ((event.ctrlKey || event.metaKey) && (event.key === 'Home' || event.key === 'End')) {
                  event.preventDefault();
                  setActiveId(results[event.key === 'Home' ? 0 : results.length - 1]?.modelId ?? null);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  if (active) choose(active.modelId);
                }
              }}
            />
            {query && (
              <button type="button" onClick={() => { setQuery(''); search.current?.focus(); }}>
                Clear search
              </button>
            )}
          </div>
          <p className="fl-model-picker__count" role="status" aria-atomic="true">
            {!capabilities.length
              ? 'No models in the current catalog. Refresh the catalog to see model support.'
              : results.length
                ? `${results.length} ${results.length === 1 ? 'model' : 'models'}`
                : 'No matching models. Try another name, ID or capability.'}
          </p>
          <div id={`${id}-results`} className="fl-model-picker__results" role="listbox" aria-label="Models" tabIndex={-1}>
            {results.map((model, index) => (
              <div
                key={model.modelId}
                id={`${id}-option-${index}`}
                role="option"
                aria-labelledby={`${id}-name-${index}`}
                aria-describedby={`${id}-detail-${index}`}
                aria-selected={model.modelId === value}
                className="fl-model-picker__option"
                data-active={activeIndex === index}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(model.modelId)}
              >
                <div className="fl-model-picker__option-heading">
                  <strong id={`${id}-name-${index}`}>{model.name}</strong>
                  {model.modelId === value && (
                    <span className="fl-model-picker__selected" aria-hidden="true">Selected</span>
                  )}
                </div>
                <div id={`${id}-detail-${index}`}>
                  <span className="fl-model-picker__literal">{model.modelId}</span>
                  <span className="fl-model-picker__route" data-route={model.availability}>
                    {routeLabel(model)}
                  </span>
                  <dl className="fl-model-picker__metadata">
                    <div>
                      <dt>Duration</dt>
                      <dd>{model.durations.map((duration) => `${duration} s`).join(', ') || 'Not listed'}</dd>
                    </div>
                    <div><dt>Resolution</dt><dd>{model.resolutions.join(', ') || 'Not listed'}</dd></div>
                    <div>
                      <dt>Frames</dt>
                      <dd>
                        {model.frameRoles.length
                          ? model.frameRoles.map((role) => <span key={role}>{frameLabel(role)}</span>)
                          : 'Not listed'}
                      </dd>
                    </div>
                    <div><dt>Seed</dt><dd>{model.seedSupported ? 'Seed supported' : 'Seed not supported'}</dd></div>
                  </dl>
                  {(model.blocker || model.availability !== 'available') && (
                    <p>{routeNote(model)}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p id={`${id}-keys`} className="fl-model-picker__keys">
            ↑ ↓ to explore, Enter to choose. Esc to close.
          </p>
        </div>
      )}
      {!selected && value && (
        <p className="fl-model-picker__notice">
          The selected ID is not in the current catalog. Your selection is kept.
        </p>
      )}
      <p id={`${id}-help`} className="fl-model-picker__help">
        Other settings and frames stay unchanged. Route access is checked at review.
      </p>
    </div>
  );
}
