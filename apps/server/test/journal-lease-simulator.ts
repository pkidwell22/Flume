/**
 * Behavioural model of the two PostgreSQL tables the continuation journal depends on
 * (`flume.continue_shot_journal` + `flume.authoring_operation_leases`, migration 011).
 *
 * WHY THIS EXISTS. The production failure this file guards against is a *guard* bug: the fenced
 * save could never match the journal row `begin` had just inserted, so the first legitimate
 * `advance()` threw CONTINUE_CONCURRENT against a real database. A scripted executor that returns
 * canned `{ rows: [...] }` cannot see that bug, because the mock — not the predicate — decides
 * success. This model therefore stores the SAME TWO TABLES with DISTINCT columns:
 *
 *   - the journal row has its own nullable `owner_token`, `fence` (default 0) and nullable
 *     `lease_expires_at` mirror, initialised exactly as the migration initialises them (the insert
 *     in `begin()` does not populate them);
 *   - `authoring_operation_leases` is the separate authority, keyed by `(scope, operation_id)`.
 *
 * and it EVALUATES THE GUARD PREDICATES IT FINDS IN THE STATEMENT TEXT against that state. Success
 * is therefore a consequence of the SQL, not of the mock.
 *
 * DISCLOSED LIMITS — do not read more into a green run than this:
 *  - It is not PostgreSQL. There is no planner, no MVCC, no row locks, no trigger, no FK/CHECK
 *    enforcement, and no interval arithmetic beyond millisecond addition.
 *  - A predicate or statement it does not recognise THROWS (`SIMULATOR_UNSUPPORTED_*`), so a new or
 *    altered guard can never be silently ignored; but passing here does not prove the SQL is valid
 *    for a real server, and it cannot reproduce PostgreSQL-specific evaluation (EvalPlanQual
 *    re-checks, type coercion, NULL sort order).
 *  - Concurrency is modelled by ORDERING calls, not by overlapping transactions. A statement is one
 *    JavaScript turn, so a lost-CAS race is expressed as "the row changed before this statement ran",
 *    which is what the adapter's own single-statement guards are supposed to tolerate.
 *  - `uuid` columns are compared case-insensitively (as PostgreSQL does), while the text-typed
 *    `authoring_operation_leases.operation_id` is compared exactly (also as PostgreSQL does), so a
 *    mixed-case lease key fails here exactly as it would fail there.
 *
 * The coordinator's authorized disposable-PostgreSQL harness remains the only real-SQL evidence.
 */

export type SimJournalRow = {
  operation_id: string; project_id: string; actor_id: string; actor_kind: string; intent_hash: string;
  source_take_id: string; source_shot_id: string; source_asset_id: string; source_asset_sha256: string;
  title: string; prompt: string; status: string; extraction_dispatched: boolean;
  extracted_asset_id: string | null; shot_id: string | null; shot_revision: number | null;
  create_payload: unknown; create_payload_hash: string | null; bind_payload: unknown; bind_payload_hash: string | null;
  command_actor_id: string | null; command_actor_kind: string | null; blockers: unknown;
  message: string | null; resumable: boolean;
  /** Journal-local mirror of the lease. Null/0 until a lease has been stamped onto the row. */
  owner_token: string | null; fence: number; lease_expires_at: number | null;
  created_at: number; updated_at: number;
};

export type SimLeaseRow = {
  scope: string; operation_id: string; project_id: string; owner_token: string;
  fence: number; lease_expires_at: number; acquired_at: number; released_at: number | null;
};

export type SimCall = {
  kind: string;
  mutates: boolean;
  text: string;
  params: unknown[];
  rowCount: number;
};

const uuid = (value: unknown): string => String(value ?? '').toLowerCase();
const isUuid = (left: unknown, right: unknown): boolean => uuid(left) === uuid(right);
const ms = (value: unknown): number => (value instanceof Date ? value.getTime() : Number(value));
const stamp = (value: number): Date => new Date(value);

function matchParens(text: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, index + 1);
    }
  }
  throw new Error('SIMULATOR_UNBALANCED_EXISTS');
}

/** Pull the first `EXISTS (...)` sub-expression out of a predicate block and return the remainder. */
function pullExists(block: string): { expression: string | null; rest: string } {
  const start = block.search(/\bEXISTS\s*\(/i);
  if (start < 0) return { expression: null, rest: block };
  const open = block.indexOf('(', start);
  const expression = matchParens(block, open);
  return { expression, rest: block.slice(0, start) + block.slice(open + expression.length) };
}

function splitPredicates(block: string): string[] {
  return block
    .replace(/\bWHERE\b/i, ' ')
    .split(/\s+AND\s+/i)
    .map(part => part.trim().replace(/;$/, '').trim())
    .filter(part => part.length > 0 && part !== '1 = 1');
}

/** Drop the `SELECT 1 FROM <table> [alias]` lead-in of an EXISTS sub-query, keeping its predicates. */
function stripSelectLead(block: string): string {
  return block.replace(/^\s*SELECT\s+1\s+FROM\s+[\w."]+\s+(?:AS\s+)?[a-z_]\w*/i, ' ');
}

const blockFrom = (text: string, marker: RegExp, until: RegExp): string => {
  const match = marker.exec(text);
  if (!match) throw new Error(`SIMULATOR_UNSUPPORTED_STATEMENT: missing ${String(marker)}`);
  const rest = text.slice(match.index);
  const end = until.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
};

const LEASE_PREDICATES: Array<{ pattern: RegExp; check: (row: SimLeaseRow, params: unknown[], match: RegExpExecArray, now: number) => boolean }> = [
  { pattern: /^l\.scope = '(continue-shot|storyboard\.apply)'$/, check: (row, _params, match) => row.scope === match[1] },
  { pattern: /^l\.operation_id = \$(\d+)$/, check: (row, params, match) => row.operation_id === String(params[Number(match[1]) - 1]) },
  { pattern: /^l\.project_id = \$(\d+)$/, check: (row, params, match) => isUuid(row.project_id, params[Number(match[1]) - 1]) },
  { pattern: /^l\.owner_token = \$(\d+)$/, check: (row, params, match) => isUuid(row.owner_token, params[Number(match[1]) - 1]) },
  { pattern: /^l\.fence = \$(\d+)$/, check: (row, params, match) => row.fence === Number(params[Number(match[1]) - 1]) },
  { pattern: /^l\.released_at IS NULL$/, check: row => row.released_at === null },
  { pattern: /^l\.lease_expires_at > clock_timestamp\(\)$/, check: (row, _params, _match, now) => row.lease_expires_at > now },
];

const JOURNAL_PREDICATES: Array<{ pattern: RegExp; check: (row: SimJournalRow, params: unknown[], match: RegExpExecArray, now: number) => boolean }> = [
  { pattern: /^([jt])\.operation_id = \$(\d+)$/, check: (row, params, match) => isUuid(row.operation_id, params[Number(match[2]) - 1]) },
  { pattern: /^([jt])\.project_id = \$(\d+)$/, check: (row, params, match) => isUuid(row.project_id, params[Number(match[2]) - 1]) },
  { pattern: /^([jt])\.status = ANY\(\$(\d+)::text\[\]\)$/, check: (row, params, match) => {
    const from = params[Number(match[2]) - 1];
    if (!Array.isArray(from)) throw new Error('SIMULATOR_UNSUPPORTED_STATUS_PARAM: expected a string[] parameter');
    return (from as string[]).includes(row.status);
  } },
  { pattern: /^([jt])\.owner_token = \$(\d+)$/, check: (row, params, match) => row.owner_token !== null && isUuid(row.owner_token, params[Number(match[2]) - 1]) },
  { pattern: /^([jt])\.fence = \$(\d+)$/, check: (row, params, match) => row.fence === Number(params[Number(match[2]) - 1]) },
  { pattern: /^([jt])\.lease_expires_at IS NOT NULL$/, check: row => row.lease_expires_at !== null },
  // NULL > x is NULL, which a WHERE clause treats as false.
  { pattern: /^([jt])\.lease_expires_at > clock_timestamp\(\)$/, check: (row, _params, _match, now) => row.lease_expires_at !== null && row.lease_expires_at > now },
];

function evalLeasePredicate(predicate: string, row: SimLeaseRow, params: unknown[], now: number): boolean {
  for (const entry of LEASE_PREDICATES) {
    const match = entry.pattern.exec(predicate);
    if (match) return entry.check(row, params, match, now);
  }
  throw new Error(`SIMULATOR_UNSUPPORTED_PREDICATE: ${predicate}`);
}

function evalJournalPredicate(predicate: string, row: SimJournalRow, params: unknown[], now: number): boolean {
  for (const entry of JOURNAL_PREDICATES) {
    const match = entry.pattern.exec(predicate);
    if (match) return entry.check(row, params, match, now);
  }
  throw new Error(`SIMULATOR_UNSUPPORTED_PREDICATE: ${predicate}`);
}

const MIRROR_ASSIGNMENTS: Record<string, (lease: SimLeaseRow) => unknown> = {
  'renewed.owner_token': lease => lease.owner_token,
  'l.owner_token': lease => lease.owner_token,
  'renewed.fence': lease => lease.fence,
  'l.fence': lease => lease.fence,
  'renewed.lease_expires_at': lease => lease.lease_expires_at,
  'l.lease_expires_at': lease => lease.lease_expires_at,
};

const COPYABLE = new Set<keyof SimJournalRow>([
  'status', 'extraction_dispatched', 'extracted_asset_id', 'shot_id', 'shot_revision',
  'create_payload', 'create_payload_hash', 'bind_payload', 'bind_payload_hash', 'blockers',
  'message', 'resumable', 'owner_token', 'fence', 'lease_expires_at', 'updated_at',
]);

function coerce(field: keyof SimJournalRow, value: unknown): unknown {
  if (value === null || value === undefined) return field === 'fence' ? 0 : null;
  if (field === 'extraction_dispatched' || field === 'resumable') return value === true;
  if (field === 'shot_revision') return Number(value);
  if (field === 'fence') return Number(value);
  if (field === 'create_payload' || field === 'bind_payload' || field === 'blockers') {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }
  return value;
}

export function createJournalLeaseSimulator(options: { startMs?: number } = {}) {
  const startMs = options.startMs ?? Date.parse('2026-01-01T00:00:00.000Z');
  let now = startMs;
  const journal = new Map<string, SimJournalRow>();
  const leases = new Map<string, SimLeaseRow>();
  const calls: SimCall[] = [];

  const leaseKey = (scope: string, operationId: string): string => `${scope}\u0000${operationId}`;
  const findLease = (scope: string, operationId: unknown): SimLeaseRow | undefined => leases.get(leaseKey(scope, String(operationId)));

  /** The lease a predicate block points at, resolved from its own `scope`/`operation_id` literals. */
  const resolveLease = (predicates: string[], params: unknown[]): SimLeaseRow | undefined => {
    const scope = predicates.map(p => /^l\.scope = '([^']+)'$/.exec(p)).find(Boolean)?.[1];
    const id = predicates.map(p => /^l\.operation_id = \$(\d+)$/.exec(p)).find(Boolean)?.[1];
    if (!scope || !id) throw new Error('SIMULATOR_UNSUPPORTED_PREDICATE: lease guard without scope/operation_id');
    return findLease(scope, params[Number(id) - 1]);
  };

  const journalOf = (predicates: string[], params: unknown[]): SimJournalRow | undefined => {
    const id = predicates.map(p => /^[jt]\.operation_id = \$(\d+)$/.exec(p)).find(Boolean)?.[1];
    if (!id) throw new Error('SIMULATOR_UNSUPPORTED_PREDICATE: journal guard without operation_id');
    return journal.get(uuid(params[Number(id) - 1]));
  };

  const leaseBlockHolds = (expression: string, params: unknown[]): boolean => {
    const inner = stripSelectLead(expression.slice(expression.indexOf('(') + 1, -1));
    const { expression: nested, rest } = pullExists(inner);
    const predicates = splitPredicates(rest);
    const row = resolveLease(predicates, params);
    if (nested) throw new Error('SIMULATOR_UNSUPPORTED_PREDICATE: EXISTS nested inside a lease guard');
    return row !== undefined && predicates.every(predicate => evalLeasePredicate(predicate, row, params, now));
  };

  const journalBlockHolds = (expression: string, params: unknown[]): boolean => {
    const inner = stripSelectLead(expression.slice(expression.indexOf('(') + 1, -1));
    const { expression: nested, rest } = pullExists(inner);
    const predicates = splitPredicates(rest);
    if (nested) throw new Error('SIMULATOR_UNSUPPORTED_PREDICATE: EXISTS nested inside a journal guard');
    const row = journalOf(predicates, params);
    return row !== undefined && predicates.every(predicate => evalJournalPredicate(predicate, row, params, now));
  };

  function insertJournal(params: unknown[]): SimJournalRow | null {
    const operationId = uuid(params[0]);
    if (journal.has(operationId)) return null; // ON CONFLICT (operation_id) DO NOTHING
    const row: SimJournalRow = {
      operation_id: String(params[0]), project_id: String(params[1]), actor_id: String(params[2]),
      actor_kind: String(params[3]), intent_hash: String(params[4]), source_take_id: String(params[5]),
      source_shot_id: String(params[6]), source_asset_id: String(params[7]), source_asset_sha256: String(params[8]),
      title: String(params[9]), prompt: String(params[10]), status: String(params[11]),
      extraction_dispatched: params[12] === true, extracted_asset_id: (params[13] ?? null) as string | null,
      shot_id: (params[14] ?? null) as string | null,
      shot_revision: params[15] === null || params[15] === undefined ? null : Number(params[15]),
      create_payload: typeof params[16] === 'string' ? JSON.parse(params[16] as string) : (params[16] ?? null),
      create_payload_hash: (params[17] ?? null) as string | null,
      bind_payload: typeof params[18] === 'string' ? JSON.parse(params[18] as string) : (params[18] ?? null),
      bind_payload_hash: (params[19] ?? null) as string | null,
      command_actor_id: String(params[2] ?? '') || null, command_actor_kind: String(params[3] ?? '') || null,
      blockers: typeof params[20] === 'string' ? JSON.parse(params[20] as string) : (params[20] ?? []),
      message: (params[21] ?? null) as string | null, resumable: Boolean(params[22] ?? true),
      // Migration 011 DDL defaults: the insert does NOT populate the lease mirror.
      owner_token: null, fence: 0, lease_expires_at: null,
      created_at: now, updated_at: now,
    };
    journal.set(operationId, row);
    return row;
  }

  function acquireLease(params: unknown[]): SimLeaseRow | null {
    const [scope, operationId, projectId, ownerToken, ttl] = params as [string, string, string, string, number];
    const key = leaseKey(scope, operationId);
    const existing = leases.get(key);
    const next: SimLeaseRow = existing
      ? { ...existing }
      : { scope, operation_id: operationId, project_id: projectId, owner_token: ownerToken, fence: 1, lease_expires_at: now + Number(ttl), acquired_at: now, released_at: null };
    if (existing) {
      const takeoverAllowed = existing.project_id === projectId
        && (existing.released_at !== null || existing.lease_expires_at <= now || existing.owner_token === ownerToken);
      if (!takeoverAllowed) return null;
      next.fence = existing.fence + 1;
      next.owner_token = ownerToken;
      next.lease_expires_at = now + Number(ttl);
      next.acquired_at = now;
      next.released_at = null;
    }
    leases.set(key, next);
    return next;
  }

  function stampJournal(text: string, params: unknown[]): SimJournalRow | null {
    const block = blockFrom(text, /WHERE\s+j\.operation_id\s*=/, /RETURNING/i);
    const { expression, rest } = pullExists(block);
    if (expression) throw new Error('SIMULATOR_UNSUPPORTED_PREDICATE: EXISTS inside the journal mirror stamp');
    const predicates = splitPredicates(rest);
    const leasePredicates = predicates.filter(p => p.startsWith('l.'));
    const journalPredicates = predicates.filter(p => p.startsWith('j.'));
    const row = journalOf(journalPredicates, params);
    const lease = resolveLease(leasePredicates, params);
    if (!row || !lease) return null;
    if (!journalPredicates.every(p => evalJournalPredicate(p, row, params, now))) return null;
    if (!leasePredicates.every(p => evalLeasePredicate(p, lease, params, now))) return null;
    row.owner_token = lease.owner_token;
    row.fence = lease.fence;
    row.lease_expires_at = lease.lease_expires_at;
    row.updated_at = now;
    return row;
  }

  function saveJournal(text: string, params: unknown[]): SimJournalRow | null {
    const outerBlock = blockFrom(text, /WHERE\s+j\.operation_id\s*=/, /RETURNING/i);
    const renewalText = /UPDATE flume\.authoring_operation_leases l/i.test(text)
      ? blockFrom(text, /UPDATE flume\.authoring_operation_leases l/i, /RETURNING/i)
      : null;

    let renewed: SimLeaseRow | null = null;
    if (renewalText) {
      const ttlMatch = /\$(\d+)::int \* interval '1 millisecond'/.exec(renewalText);
      if (!ttlMatch) throw new Error('SIMULATOR_UNSUPPORTED_PREDICATE: lease renewal without a ttl parameter');
      const ttl = Number(params[Number(ttlMatch[1]) - 1]);
      const renewalWhere = blockFrom(renewalText, /WHERE\s+l\./, /$/);
      const { expression, rest } = pullExists(renewalWhere);
      const predicates = splitPredicates(rest);
      const lease = resolveLease(predicates, params);
      const leaseHolds = lease !== undefined && predicates.every(p => evalLeasePredicate(p, lease, params, now));
      const journalHolds = expression === null ? true : journalBlockHolds(expression, params);
      if (leaseHolds && journalHolds) {
        lease.lease_expires_at = now + ttl;
        renewed = lease;
      }
    }

    const outer = pullExists(outerBlock);
    const journalPredicates = splitPredicates(outer.rest);
    const row = journalOf(journalPredicates, params);
    const ownsByJournalColumns = journalPredicates.some(p => /^j\.(owner_token|fence|lease_expires_at)/.test(p));
    if (!ownsByJournalColumns && !outer.expression && !renewalText) {
      throw new Error('SIMULATOR_NO_OWNERSHIP_GUARD: a journal save must be fenced by the lease or by the journal mirror');
    }
    const holds = row !== undefined
      && journalPredicates.every(p => evalJournalPredicate(p, row, params, now))
      && (outer.expression === null || leaseBlockHolds(outer.expression, params))
      && (!/FROM renewed/i.test(text) || renewed !== null);
    if (!holds) return null;

    // Only the journal's own SET list counts: a renewal CTE above it has its own SET.
    const updateAt = text.search(/UPDATE flume\.continue_shot_journal/i);
    if (updateAt < 0) throw new Error('SIMULATOR_UNSUPPORTED_STATEMENT: no journal UPDATE');
    const head = text.slice(updateAt);
    const setMatch = /\bSET\b/i.exec(head);
    if (!setMatch) throw new Error('SIMULATOR_UNSUPPORTED_STATEMENT: journal UPDATE without SET');
    const setTail = head.slice(setMatch.index);
    const fromAt = setTail.search(/\sFROM\s/);
    const whereAt = setTail.search(/\sWHERE\s/);
    const cut = [fromAt, whereAt].filter(index => index >= 0).sort((left, right) => left - right)[0] ?? setTail.length;
    const setBlock = setTail.slice(0, cut);
    const assignments = [...setBlock.matchAll(/([a-z_]+) = (\$\d+|renewed\.[a-z_]+|l\.[a-z_]+|clock_timestamp\(\))/g)];
    if (assignments.length === 0) throw new Error('SIMULATOR_UNSUPPORTED_STATEMENT: journal save without assignments');
    for (const [, field, value] of assignments) {
      const column = field as keyof SimJournalRow;
      if (!COPYABLE.has(column)) throw new Error(`SIMULATOR_UNSUPPORTED_COLUMN: ${field}`);
      if (value === 'clock_timestamp()') {
        (row as unknown as Record<string, unknown>)[column] = column === 'updated_at' ? now : now;
        continue;
      }
      const mirror = MIRROR_ASSIGNMENTS[value];
      if (mirror) {
        if (!renewed) throw new Error('SIMULATOR_UNSUPPORTED_STATEMENT: lease mirror assignment without a renewal');
        (row as unknown as Record<string, unknown>)[column] = coerce(column, mirror(renewed));
        continue;
      }
      const index = Number(/\$(\d+)/.exec(value)![1]) - 1;
      const assigned = coerce(column, params[index]);
      (row as unknown as Record<string, unknown>)[column] = column === 'updated_at' ? now : assigned;
    }
    return row;
  }

  function toJournalRow(row: SimJournalRow) {
    return {
      ...row,
      extracted_asset_id: row.extracted_asset_id, shot_id: row.shot_id,
      lease_expires_at: row.lease_expires_at === null ? null : stamp(row.lease_expires_at),
      created_at: stamp(row.created_at), updated_at: stamp(row.updated_at),
    };
  }

  const sql = {
    async query(text: string, params: unknown[] = []) {
      const record = (kind: string, mutates: boolean, rowCount: number, rows: unknown[] = []) => {
        calls.push({ kind, mutates, text, params, rowCount });
        return { rows: rows as any[], rowCount };
      };

      if (text.includes('INSERT INTO flume.continue_shot_journal')) {
        const row = insertJournal(params);
        return record('journal.insert', true, row ? 1 : 0, row ? [toJournalRow(row)] : []);
      }
      if (text.includes('INSERT INTO flume.authoring_operation_leases')) {
        const lease = acquireLease(params);
        return record('lease.acquire', true, lease ? 1 : 0, lease ? [{
          project_id: lease.project_id, owner_token: lease.owner_token, fence: lease.fence,
          lease_expires_at: stamp(lease.lease_expires_at),
        }] : []);
      }
      if (/^\s*SELECT project_id, owner_token, fence, lease_expires_at, released_at/.test(text)) {
        const lease = findLease(String(params[0]), params[1]);
        return record('lease.inspect', false, lease ? 1 : 0, lease ? [{
          project_id: lease.project_id, owner_token: lease.owner_token, fence: lease.fence,
          lease_expires_at: stamp(lease.lease_expires_at),
          released_at: lease.released_at === null ? null : stamp(lease.released_at),
          live: lease.released_at === null && lease.lease_expires_at > now,
        }] : []);
      }
      if (text.includes('UPDATE flume.authoring_operation_leases') && text.includes('SET released_at')) {
        const lease = findLease(String(params[0]), params[1]);
        const released = lease !== undefined && lease.released_at === null
          && isUuid(lease.owner_token, params[2]) && lease.fence === Number(params[3]);
        if (released) lease.released_at = now;
        return record('lease.release', true, released ? 1 : 0);
      }
      if (text.includes('SET owner_token = NULL')) {
        const row = journal.get(uuid(params[0]));
        const cleared = row !== undefined && row.owner_token !== null
          && isUuid(row.owner_token, params[1]) && row.fence === Number(params[2]);
        if (row && cleared) {
          row.owner_token = null;
          row.lease_expires_at = null;
          row.updated_at = now;
        }
        return record('journal.clear-mirror', true, cleared ? 1 : 0);
      }
      if (text.includes('SET owner_token = l.owner_token')) {
        const row = stampJournal(text, params);
        return record('journal.stamp-mirror', true, row ? 1 : 0, row ? [toJournalRow(row)] : []);
      }
      if (text.includes('UPDATE flume.continue_shot_journal')) {
        const row = saveJournal(text, params);
        return record('journal.save', true, row ? 1 : 0, row ? [toJournalRow(row)] : []);
      }
      if (/^\s*SELECT \* FROM flume\.continue_shot_journal/.test(text)) {
        const row = journal.get(uuid(params[0]));
        return record('journal.load', false, row ? 1 : 0, row ? [toJournalRow(row)] : []);
      }
      throw new Error(`SIMULATOR_UNSUPPORTED_STATEMENT: ${text.trim().split('\n')[0]}`);
    },
  };

  return {
    sql,
    calls,
    /** Table state for assertions. The adapter never calls these. */
    journalRow(operationId: string): SimJournalRow | null {
      return journal.get(uuid(operationId)) ?? null;
    },
    leaseRow(scope: string, operationId: string): SimLeaseRow | null {
      return findLease(scope, String(operationId)) ?? null;
    },
    /** Move the model clock forward, as if that many milliseconds had passed. */
    advance(milliseconds: number) { now += milliseconds; },
    now() { return now; },
    /** Statements issued since an earlier `calls.length`, used to prove reads never mutate. */
    writesSince(index: number): SimCall[] {
      return calls.slice(index).filter(entry => entry.mutates);
    },
  };
}

export type JournalLeaseSimulator = ReturnType<typeof createJournalLeaseSimulator>;
