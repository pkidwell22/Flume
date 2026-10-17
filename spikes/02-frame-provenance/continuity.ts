import { randomUUID } from 'node:crypto';
import type { Extraction, Inspection } from './media.ts';

export interface Binding {
  kind: 'conditioning-image'; role: 'first-frame' | 'last-frame'; assetId: string;
  image: Extraction['image']; provenance: Extraction;
}
interface Ticket { token: string; revision: number; sourceSha256: string; streamIndex: number }
interface DraftState { id: string; revision: number; first: Binding | null; last: Binding | null }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
function binding(frame: Extraction, role: Binding['role']): Binding {
  return structuredClone({ kind: 'conditioning-image', role, assetId: `sha256:${frame.image.sha256}`, image: frame.image, provenance: frame });
}

// Single-process compare-and-set experiment, NOT a database transaction service.
// Every first-input edit/clear/new extraction advances the revision (ABA-safe).
export class ContinuityDraft {
  private state: DraftState;
  private pending: Ticket | null = null;
  constructor(id: string) { this.state = { id, revision: 0, first: null, last: null }; }
  chooseFirst(frame: Extraction | null): void {
    this.state.first = frame ? binding(frame, 'first-frame') : null;
    this.state.revision++; this.pending = null;
  }
  chooseLast(frame: Extraction | null): void {
    this.state.last = frame ? binding(frame, 'last-frame') : null;
    this.state.revision++; this.pending = null;
  }
  beginFirst(source: Inspection): Ticket {
    this.state.revision++;
    this.pending = { token: randomUUID(), revision: this.state.revision, sourceSha256: source.sourceSha256, streamIndex: source.streamIndex };
    return Object.freeze({ ...this.pending });
  }
  completeFirst(ticket: Ticket, frame: Extraction): 'applied' | 'stale' | 'source-mismatch' {
    if (!this.pending || ticket.token !== this.pending.token || ticket.revision !== this.state.revision) return 'stale';
    if (frame.source.sourceSha256 !== this.pending.sourceSha256 || frame.source.streamIndex !== this.pending.streamIndex) return 'source-mismatch';
    // No await between checking the fence and setting the binding.
    this.chooseFirst(frame);
    return 'applied';
  }
  freeze(): DraftState { return deepFreeze(this.snapshot()); }
  snapshot(): DraftState { return structuredClone(this.state); }
}
