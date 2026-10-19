import { useId, useLayoutEffect, useRef, useState } from 'react';
import { resolveTextareaEdit, resolveTextareaReplacement, insertPromptText, type TextareaEdit } from './prompt-insertion.ts';
import { useAnchoredPopup } from './useAnchoredPopup.ts';

export interface PromptComposerProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

// Original, editable prose — not provider fields or a parser for the user's prompt.
const directions = [
  { label: 'Static shot', text: 'Keep the camera still.' },
  { label: 'Dolly in', text: 'Move the camera toward the subject.' },
  { label: 'Dolly out', text: 'Move the camera away from the subject.' },
  { label: 'Arc left', text: 'Move the camera in an arc to the left around the subject.' },
  { label: 'Arc right', text: 'Move the camera in an arc to the right around the subject.' },
  { label: 'Rack focus', text: 'Shift focus from the foreground to the background.' },
] as const;

type Selection = { value: string; start: number; end: number; direction: 'forward' | 'backward' | 'none' };

export function PromptComposer({ value, onChange, disabled = false }: PromptComposerProps) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [rejected, setRejected] = useState<{ source: string; text: string } | null>(null);
  const selection = useRef<Selection | null>(null);
  const anchor = useRef<Selection | null>(null);
  const pending = useRef<{ value: string; caret: number; original: Selection } | null>(null);

  useAnchoredPopup(open && !disabled, trigger, panel, () => setOpen(false));
  const nativeEdit = useRef<(TextareaEdit & { value: string; event: InputEvent }) | null>(null);
  const handledInput = useRef<Event | null>(null);
  // Native undo grouping is browser-owned. Equal literal results can have
  // several possible positions; keep them all, never pick a different source.
  const history = useRef({ values: [value], indices: [0] });

  function syncHistory() {
    if (history.current.indices.some(index => history.current.values[index] !== value)) history.current = { values: [value], indices: [0] };
  }

  useLayoutEffect(() => {
    syncHistory();
    setRejected(current => current?.source === value ? current : null);
    const field = textarea.current;
    if (!field) return;
    // React's synthetic beforeInput does not expose every native InputEvent.
    let expiry: ReturnType<typeof setTimeout>;
    const beforeInput = (event: InputEvent) => {
      clearTimeout(expiry);
      nativeEdit.current = !disabled && field.value === value.replace(/\r\n?/g, '\n')
        ? { value, start: field.selectionStart, end: field.selectionEnd, inputType: event.inputType, event }
        : null;
      // beforeinput and its default input belong to one native editing task.
      // An operation with no input must not lend its range to a later task.
      expiry = setTimeout(() => { nativeEdit.current = null; }, 0);
    };
    field.addEventListener('beforeinput', beforeInput);
    nativeEdit.current = null;
    return () => { clearTimeout(expiry); field.removeEventListener('beforeinput', beforeInput); };
  }, [value, disabled]);

  function editText(event: { currentTarget: HTMLTextAreaElement; nativeEvent: Event }) {
    if (handledInput.current === event.nativeEvent) return;
    handledInput.current = event.nativeEvent;
    const edit = nativeEdit.current;
    nativeEdit.current = null;
    if (disabled) return;
    const field = event.currentTarget;
    syncHistory();
    const inputType = (event.nativeEvent as InputEvent).inputType;
    let next: string | null = null;
    const log = history.current;
    if (inputType === 'historyUndo' || inputType === 'historyRedo') {
      const candidates = log.values.map((source, index) => ({ source, index })).filter(({ source, index }) =>
        log.indices.some(current => inputType === 'historyUndo' ? index < current : index > current) && source.replace(/\r\n?/g, '\n') === field.value);
      if (new Set(candidates.map(candidate => candidate.source)).size === 1) {
        next = candidates[0]!.source;
        log.indices = candidates.map(candidate => candidate.index);
      }
    } else {
      const input = event.nativeEvent as InputEvent;
      // Chromium insertText("\n") reports insertLineBreak/null at input;
      // composition cancellation reports empty data as null. Match those exact
      // operation semantics, not just a type-shaped stale range.
      const lineBreak = edit?.inputType === 'insertText' && edit.event.data === '\n' &&
        inputType === 'insertLineBreak' && input.data === null &&
        field.value === value.replace(/\r\n?/g, '\n').slice(0, edit.start) + '\n' + value.replace(/\r\n?/g, '\n').slice(edit.end);
      const multiline = edit?.inputType === 'insertText' && edit.event.data?.includes('\n') &&
        (input.data ?? '') === edit.event.data.split('\n')[0] &&
        field.value === value.replace(/\r\n?/g, '\n').slice(0, edit.start) + edit.event.data + value.replace(/\r\n?/g, '\n').slice(edit.end);
      const mismatched = edit && (edit.value !== value || edit.event.defaultPrevented ||
        edit.event.isTrusted !== input.isTrusted || edit.event.isComposing !== input.isComposing ||
        (!lineBreak && (edit.inputType !== inputType || (!multiline && (edit.event.data ?? '') !== (input.data ?? '')))));
      next = inputType === 'insertReplacementText'
        ? resolveTextareaReplacement(value, field.value, input.data, field.selectionStart, field.selectionEnd)
        // Chromium can emit trailing insertText events for an already-applied
        // multiline insertion. A no-op never grants authority to splice source.
        : !edit && inputType === 'insertText' && field.value === value.replace(/\r\n?/g, '\n') ? value
        : mismatched ? null : resolveTextareaEdit(value, field.value, edit ?? undefined);
      if (next !== null && next !== value) {
        // A new branch cannot choose which unresolved old position to truncate.
        // Start at the known literal value; crossing that boundary is recoverable.
        log.values = [...(log.indices.length === 1 ? log.values.slice(0, log.indices[0]! + 1) : [value]), next];
        log.indices = [log.values.length - 1];
      }
    }
    if (next === null) {
      if (inputType === 'historyUndo' || inputType === 'historyRedo') history.current = { values: [value], indices: [0] };
      const { selectionStart: start, selectionEnd: end } = field;
      setRejected({ source: value, text: field.value });
      field.value = value.replace(/\r\n?/g, '\n');
      field.setSelectionRange(start, end);
      return;
    }
    setRejected(null);
    if (next !== value) onChange(next);
  }

  useLayoutEffect(() => {
    if (disabled || (open && anchor.current?.value !== value)) {
      if (!disabled && panel.current?.contains(document.activeElement)) trigger.current?.focus();
      setOpen(false);
      anchor.current = null;
      pending.current = null;
      return;
    }
    if (pending.current) {
      const edit = pending.current;
      // Only the synchronous controlled echo owns this focus restoration.
      // A later server echo must never take focus away from another field.
      pending.current = null;
      const range = value === edit.value
        ? { start: edit.caret, end: edit.caret, direction: 'none' as const }
        : value === edit.original.value ? edit.original : null;
      if (range) {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(range.start, range.end, range.direction);
        rememberSelection();
      }
    }
    if (open) firstChoice.current?.focus();
  }, [value, open, disabled]);

  function rememberSelection() {
    const field = textarea.current;
    if (field && !disabled) selection.current = {
      value,
      start: field.selectionStart,
      end: field.selectionEnd,
      direction: field.selectionDirection,
    };
  }

  function toggleDirections() {
    if (disabled) return;
    const end = textarea.current?.value.length ?? value.length;
    anchor.current = selection.current?.value === value
      ? selection.current
      : { value, start: end, end, direction: 'none' };
    setOpen(!open);
  }

  function insert(text: string) {
    const range = anchor.current;
    if (disabled || !open || !range || range.value !== value) return;
    const next = insertPromptText(value, range.start, range.end, text);
    pending.current = { ...next, original: range };
    selection.current = { value: next.value, start: next.caret, end: next.caret, direction: 'none' };
    setOpen(false);
    onChange(next.value);
  }

  function dismiss() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div
      className="fl-prompt-composer"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={event => {
        if (open && event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <div className="fl-prompt-composer__heading">
        <label htmlFor={`${id}-prompt`}>Prompt</label>
        <span>Describe the shot and its motion</span>
      </div>
      <textarea
        ref={textarea}
        id={`${id}-prompt`}
        rows={6}
        value={value.replace(/\r\n?/g, '\n')}
        disabled={disabled}
        aria-describedby={`${id}-hint${rejected?.source === value ? ` ${id}-edit-error` : ''}`}
        onSelect={rememberSelection}
        onFocus={rememberSelection}
        onBlur={rememberSelection}
        onInput={editText}
        onChange={editText}
      />
      {rejected?.source === value && <div>
        <p id={`${id}-edit-error`} role="alert">Edit not applied: its source range or history is uncertain. Original prompt kept. Select the intended text and type or paste again.</p>
        <details open>
          <summary>Recover unapplied text</summary>
          <label htmlFor={`${id}-unapplied`}>Unapplied prompt edit</label>
          <textarea id={`${id}-unapplied`} rows={3} readOnly value={rejected.text} />
        </details>
      </div>}
      <div className="fl-prompt-composer__toolbar">
        <button
          ref={trigger}
          type="button"
          disabled={disabled}
          aria-expanded={open && !disabled}
          aria-haspopup="dialog"
          aria-controls={`${id}-directions`}
          onClick={toggleDirections}
        >Camera directions</button>
        <p id={`${id}-hint`}>Prompt guidance, not camera settings.</p>
      </div>
      {open && !disabled && (
        <section
          ref={panel}
          popover="manual"
          role="dialog"
          id={`${id}-directions`}
          className="fl-prompt-composer__directions fl-anchored-popup"
          aria-label="Camera direction guidance"
        >
          <h3>Direct the camera</h3>
          <p>Choose in shot order. Each choice inserts the sentence at your cursor, replacing selected text. Edit it there afterward.</p>
          <div className="fl-prompt-composer__choices">
            {directions.map((direction, index) => (
              <button
                key={direction.label}
                ref={index === 0 ? firstChoice : undefined}
                type="button"
                aria-label={`Insert ${direction.label}`}
                aria-describedby={`${id}-direction-${index}`}
                onClick={() => insert(direction.text)}
              >
                <strong>{direction.label}</strong>
                <span id={`${id}-direction-${index}`}>{direction.text}</span>
              </button>
            ))}
          </div>
          <div className="fl-prompt-composer__footer">
            <p>Tab to a direction. Enter or Space inserts. Escape closes.</p>
            <button type="button" onClick={dismiss} aria-label="Close camera directions">Close</button>
          </div>
        </section>
      )}
    </div>
  );
}
