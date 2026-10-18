import { uuid } from './types.ts';

/** Comparison key only: validate first, never rewrite persisted evidence or opaque IDs. */
export function uuidKey(value: unknown): string {
  uuid(value);
  return value.toLowerCase();
}
