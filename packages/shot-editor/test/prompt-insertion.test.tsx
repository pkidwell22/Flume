import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTextareaEdit, insertPromptText } from '../src/prompt-insertion.ts';

test('successive deliberate insertions retain their chosen order at the returned caret', () => {
  const first = insertPromptText('A subject.', 10, 10, 'Move the camera toward the subject.');
  const second = insertPromptText(first.value, first.caret, first.caret, 'Shift focus to the background.');
  assert.equal(first.value, 'A subject. Move the camera toward the subject.');
  assert.equal(second.value, 'A subject. Move the camera toward the subject. Shift focus to the background.');
  assert.equal(second.caret, second.value.length);
});

test('replacement preserves literal prefix and suffix without escaping or trimming', () => {
  const before = '  🦆 <tag x="&">`$1`\\\\# @ref\t';
  const selected = 'replace\nonly this';
  const after = '\n\n</tag>  ';
  const value = before + selected + after;
  const result = insertPromptText(value, before.length, before.length + selected.length, 'Keep the camera still.');
  assert.equal(result.value, before + 'Keep the camera still.' + after);
  assert.equal(result.caret, before.length + 'Keep the camera still.'.length);
});

test('inserts between non-whitespace boundaries without deleting either side', () => {
  const result = insertPromptText('leftright', 4, 4, 'Keep the camera still.');
  assert.equal(result.value, 'left Keep the camera still. right');
  assert.equal(result.value.slice(result.caret), ' right');
  const next = insertPromptText(result.value, result.caret, result.caret, 'Move back.');
  assert.equal(next.value, 'left Keep the camera still. Move back. right');
});

test('supports empty, start, end and entire-selection insertions', () => {
  assert.deepEqual(insertPromptText('', 0, 0, 'Hold.'), { value: 'Hold.', caret: 5 });
  assert.equal(insertPromptText('tail', 0, 0, 'Hold.').value, 'Hold. tail');
  assert.equal(insertPromptText('head  ', 6, 6, 'Hold.').value, 'head  Hold.');
  assert.equal(insertPromptText('all\ntext', 0, 8, 'Hold.').value, 'Hold.');
});

test('maps native textarea selection offsets without normalizing existing CRLF or CR', () => {
  const value = '  before\r\n🦆 replace\rafter  ';
  const nativeBefore = '  before\n🦆 ';
  const result = insertPromptText(value, nativeBefore.length, nativeBefore.length + 'replace'.length, 'Hold.');
  assert.equal(result.value, '  before\r\n🦆 Hold.\rafter  ');
  assert.equal(result.caret, '  before\n🦆 Hold.'.length);
});

test('native edits preserve untouched endings across typing, deletion, paste and unchanged input', () => {
  assert.equal(applyTextareaEdit('a\r\nb\rc', 'a\nb\nc'), 'a\r\nb\rc');
  assert.equal(applyTextareaEdit('a\r\nb\rc', 'xa\nb\nc', { start: 0, end: 0, inputType: 'insertText' }), 'xa\r\nb\rc');
  assert.equal(applyTextareaEdit('a\r\nb\rc', 'a\nb\ncx', { start: 5, end: 5, inputType: 'insertText' }), 'a\r\nb\rcx');
  assert.equal(applyTextareaEdit('a\r\nb\rc', 'a\n\nc', { start: 2, end: 3, inputType: 'deleteContentBackward' }), 'a\r\n\rc');
  assert.equal(applyTextareaEdit('a\r\nb\rc', 'aNEWc', { start: 1, end: 4, inputType: 'insertFromPaste' }), 'aNEWc');
  assert.equal(applyTextareaEdit('', '  🦆 # $1 <b>\n\n  '), '  🦆 # $1 <b>\n\n  ');
  assert.equal(applyTextareaEdit('all', ''), '');
});

test('all textarea boundary pairs preserve exact source outside the selected range', () => {
  const chunks = ['  ', '🦆', '\r\n', '<tag>', '\r', '$&', '\n', '\tend  '];
  const value = chunks.join('');
  const native = value.replace(/\r\n?/g, '\n');
  const sourceBoundaries = [0];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\r' && value[i + 1] === '\n') i++;
    sourceBoundaries.push(i + 1);
  }
  for (let start = 0; start <= native.length; start++) {
    for (let end = start; end <= native.length; end++) {
      const result = insertPromptText(value, start, end, 'Hold.');
      const before = value.slice(0, sourceBoundaries[start]);
      const after = value.slice(sourceBoundaries[end]);
      const inserted = `${before && !/\s$/.test(before) ? ' ' : ''}Hold.${after && !/^\s/.test(after) ? ' ' : ''}`;
      assert.equal(result.value, before + inserted + after, `range ${start}:${end}`);
    }
  }
});
