/** A textarea exposes LF line endings; preserve the caller's untouched CR/CRLF characters. */
function sourceOffset(value: string, textareaOffset: number): number {
  let source = 0;
  for (let native = 0; native < textareaOffset && source < value.length; native++) {
    if (value[source] === '\r' && value[source + 1] === '\n') source++;
    source++;
  }
  return source;
}

export type TextareaEdit = { start: number; end: number; inputType: string };

/** Apply only a witnessed native range. Textarea offsets are UTF-16, not code points.
 * New text uses native LF; untouched source slices retain their literal endings.
 * Unknown/stale ranges fail closed rather than guessing among equal-looking edits.
 */
export function applyTextareaEdit(value: string, next: string, edit?: TextareaEdit): string {
  return resolveTextareaEdit(value, next, edit) ?? value;
}

/** Null is a recoverable rejection, distinct from a successful no-op. */
export function resolveTextareaEdit(value: string, next: string, edit?: TextareaEdit): string | null {
  // An LF-only source has no hidden newline provenance when beforeinput is absent.
  if (!edit) return value.includes('\r') ? null : next;
  const selectionEdit = ['insertText', 'insertLineBreak', 'insertFromPaste', 'insertCompositionText', 'insertFromComposition', 'deleteCompositionText', 'deleteByCut'].includes(edit.inputType);
  const directionalDelete = /^delete(Content|Word|SoftLine|HardLine)(Backward|Forward)$/.test(edit.inputType);
  if (!selectionEdit && !directionalDelete) return null;
  const native = value.replace(/\r\n?/g, '\n');
  let { start, end } = edit;
  if (start === end && edit.inputType.startsWith('delete')) {
    const removed = native.length - next.length;
    if (removed < 0) return null;
    if (edit.inputType.endsWith('Backward')) start -= removed;
    else if (edit.inputType.endsWith('Forward')) end += removed;
    else return null;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > native.length) return null;
  const nextEnd = next.length - (native.length - end);
  if (nextEnd < start || next.slice(0, start) !== native.slice(0, start) || next.slice(nextEnd) !== native.slice(end)) return null;
  return value.slice(0, sourceOffset(value, start)) + next.slice(start, nextEnd) + value.slice(sourceOffset(value, end));
}

/** Replacement may omit beforeinput or expand beyond its selection (spellcheck).
 * Its inserted data and resulting collapsed caret locate the actual splice;
 * validate both unchanged sides rather than diffing repeated text or reusing selection.
 */
export function resolveTextareaReplacement(value: string, next: string, data: string | null, start: number, end: number): string | null {
  if (data === null || start !== end) return null;
  const text = data.replace(/\r\n?/g, '\n');
  const from = start - text.length;
  if (from < 0 || next.slice(from, start) !== text) return null;
  const to = value.replace(/\r\n?/g, '\n').length - (next.length - end);
  return resolveTextareaEdit(value, next, { start: from, end: to, inputType: 'insertText' });
}

/** Textarea selection offsets and the returned caret are UTF-16, with native LF line endings.
 * Only the selected range is replaced. Boundary spaces are additive; no user text is trimmed.
 */
export function insertPromptText(value: string, start: number, end: number, text: string) {
  const before = value.slice(0, sourceOffset(value, start));
  const after = value.slice(sourceOffset(value, end));
  const leading = before && !/\s$/.test(before) ? ' ' : '';
  const trailing = after && !/^\s/.test(after) ? ' ' : '';
  return {
    value: before + leading + text + trailing + after,
    caret: (before + leading + text).replace(/\r\n?/g, '\n').length,
  };
}
