// Saved shot list: a pre-production planning document built only from the
// saved Workspace. Strings in, strings out — no network, provider, command,
// storage or clipboard path exists in this module.
import type { Asset, Project, Shot } from './types.ts';

export const SHOT_LIST_FORMAT = 'flume-shot-list/v1';
export const SHOT_LIST_MARKDOWN_MIME = 'text/markdown;charset=utf-8';
export const SHOT_LIST_JSON_MIME = 'application/json;charset=utf-8';
export type ShotListKind = 'markdown' | 'json';

export interface ShotListReference {
  assetId: string;
  /** Saved file name when the asset belongs to this same project; null otherwise. */
  filename: string | null;
  status: 'saved-in-project' | 'not-in-project';
}
export interface ShotListShot {
  order: number;
  id: string;
  title: string;
  direction: string;
  revision: number;
  durationSeconds: number;
  modelId: string;
  aspectRatio: string;
  resolution: string;
  references: { start: ShotListReference | null; end: ShotListReference | null };
}
export interface ShotListDocument {
  format: typeof SHOT_LIST_FORMAT;
  project: { id: string; name: string; brief: string; revision: number };
  shots: ShotListShot[];
}
export interface ShotListInput { project: Project; shots: readonly Shot[]; assets: readonly Asset[] }
export interface ShotListFile { kind: ShotListKind; filename: string; mime: string; label: string; body: string }

const START = 'firstFrameAssetId' as const;
const END = 'lastFrameAssetId' as const;

/** Saved binding identity. Another project's asset is never resolved into this document. */
function reference(shot: Shot, key: typeof START | typeof END, assets: readonly Asset[], projectId: string): ShotListReference | null {
  const assetId = shot.bindings[key];
  if (assetId === null) return null;
  // A binding that is neither a saved id nor an explicit absence is malformed runtime input.
  // Refuse the document instead of inventing an asset identity for it.
  if (typeof assetId !== 'string' || assetId === '') throw new Error('A saved frame binding is not an asset id.');
  const asset = assets.find(item => item.id === assetId && item.projectId === projectId);
  return asset
    ? { assetId, filename: asset.filename, status: 'saved-in-project' }
    : { assetId, filename: null, status: 'not-in-project' };
}

/** The explicit, versioned field allowlist. Nothing from the Workspace is copied wholesale. */
export function buildShotList(input: ShotListInput): ShotListDocument {
  const { project } = input;
  const shots = input.shots.filter(item => item.projectId === project.id);
  return {
    format: SHOT_LIST_FORMAT,
    project: { id: project.id, name: project.name, brief: project.brief, revision: project.revision },
    shots: shots.map((item, index) => ({
      order: index + 1,
      id: item.id,
      title: item.title,
      direction: item.prompt,
      revision: item.revision,
      durationSeconds: item.controls.durationSeconds,
      modelId: item.controls.modelId,
      aspectRatio: item.controls.aspectRatio,
      resolution: item.controls.resolution,
      references: {
        start: reference(item, START, input.assets, project.id),
        end: reference(item, END, input.assets, project.id),
      },
    })),
  };
}

export function shotListJson(document: ShotListDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

const INLINE = /[&<>\\`*_[\]#|~]/g;
const INLINE_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '\\': '\\\\', '`': '\\`', '*': '\\*',
  '_': '\\_', '[': '\\[', ']': '\\]', '#': '\\#', '|': '\\|', '~': '\\~',
};

/**
 * Saved text is rendered as text. Markdown/HTML metacharacters are escaped so a
 * project title, prompt or file name cannot open HTML, images, links, tables,
 * headings, fences or new block structure. Text is escaped, never truncated.
 */
function escapeInline(value: string): string {
  return value.replace(INLINE, character => INLINE_ESCAPES[character] ?? character);
}

/** One-line fields keep their text but not their line breaks: a title cannot start a section. */
function singleLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, ' ');
}

function escapeLine(line: string): string {
  let out = escapeInline(line);
  // Leading whitespace becomes entities so an indented line cannot open a code block.
  out = out.replace(/^[ \t]+/, whitespace => Array.from(whitespace).map(character => character === '\t' ? '&#9;' : '&#32;').join(''));
  out = out.replace(/^([-+])/, '\\$1');
  out = out.replace(/^(\d{1,9})([.)])(\s|$)/, '$1\\$2$3');
  out = out.replace(/^(=+)(\s|$)/, '\\$1$2');
  return out;
}

/**
 * Markdown treats LF, CRLF and a bare CR as line boundaries, so all three are
 * normalised before splitting: every saved line start is escaped, whatever the
 * saved editor wrote. Multiline saved text keeps every line and every character.
 */
function escapeLines(value: string): string[] {
  return value.replace(/\r\n?/g, '\n').split('\n').map(escapeLine);
}

function referenceLabel(reference: ShotListReference | null): string {
  if (!reference) return 'None saved';
  const asset = escapeInline(reference.assetId);
  return reference.filename === null
    ? `Not in this project’s saved media (asset ${asset})`
    : `${escapeInline(reference.filename)} (asset ${asset})`;
}

export function shotListMarkdown(document: ShotListDocument): string {
  const lines: string[] = [
    `# Shot list · ${escapeInline(singleLine(document.project.name))}`,
    '',
    'A planning document built from saved shot values. It is not rendered video and not a generation receipt. Unsaved edits are not included. Reference bindings are saved planned inputs, not proof of the current files, rights, or what any generation used.',
    '',
    `- **Project:** ${escapeInline(singleLine(document.project.name))}`,
    `- **Saved shots:** ${document.shots.length}`,
    `- **Document format:** ${SHOT_LIST_FORMAT}`,
    '',
    '## Brief',
    '',
    ...(document.project.brief.trim() ? escapeLines(document.project.brief) : ['No brief saved.']),
    '',
  ];
  for (const shot of document.shots) {
    lines.push(`## Shot ${String(shot.order).padStart(2, '0')} · ${escapeInline(singleLine(shot.title))}`, '');
    lines.push(`- **Shot ID:** ${escapeInline(shot.id)}`);
    lines.push(`- **Revision:** ${shot.revision}`);
    lines.push(`- **Duration:** ${shot.durationSeconds} s`);
    lines.push(`- **Model:** ${escapeInline(singleLine(shot.modelId))}`);
    lines.push(`- **Aspect ratio:** ${escapeInline(singleLine(shot.aspectRatio))}`);
    lines.push(`- **Resolution:** ${escapeInline(singleLine(shot.resolution))}`);
    lines.push(`- **Start frame:** ${referenceLabel(shot.references.start)}`);
    lines.push(`- **End frame:** ${referenceLabel(shot.references.end)}`);
    lines.push('', '**Saved direction**', '');
    lines.push(...(shot.direction.trim() ? escapeLines(shot.direction) : ['No direction saved.']), '');
  }
  return lines.join('\n');
}

/** Deterministic, path-free file name: no clock, no counter, no separator the OS would read. */
export function shotListFilenames(project: Pick<Project, 'name'>): { markdown: string; json: string } {
  const folded = project.name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  const safe = slug || 'flume-project';
  return { markdown: `${safe}-shot-list.md`, json: `${safe}-shot-list.json` };
}

export function shotListFile(input: ShotListInput, kind: ShotListKind): ShotListFile {
  const document = buildShotList(input);
  const filenames = shotListFilenames(input.project);
  return kind === 'json'
    ? { kind, filename: filenames.json, mime: SHOT_LIST_JSON_MIME, label: 'JSON', body: shotListJson(document) }
    : { kind, filename: filenames.markdown, mime: SHOT_LIST_MARKDOWN_MIME, label: 'Markdown', body: shotListMarkdown(document) };
}

/** The browser surface a download needs. Tests provide their own; production uses the page. */
export interface ShotListSaveEnvironment {
  createObjectURL?: ((blob: Blob) => string) | null;
  revokeObjectURL?: ((url: string) => void) | null;
  document?: Pick<Document, 'createElement' | 'body'> | null;
}
export interface ShotListSaveResult { ok: boolean; filename: string; message: string }

export function shotListDownloadEnvironment(): ShotListSaveEnvironment {
  const urlApi: typeof URL | undefined = typeof URL === 'undefined' ? undefined : URL;
  return {
    createObjectURL: typeof urlApi?.createObjectURL === 'function' ? urlApi.createObjectURL.bind(urlApi) : null,
    revokeObjectURL: typeof urlApi?.revokeObjectURL === 'function' ? urlApi.revokeObjectURL.bind(urlApi) : null,
    document: typeof document === 'undefined' ? null : document,
  };
}

/**
 * Starts one local download for the file already built in memory. A click is
 * reported as a started download, never as a completed filesystem save.
 */
export function saveShotList(file: ShotListFile, environment: ShotListSaveEnvironment = shotListDownloadEnvironment()): ShotListSaveResult {
  const create = environment.createObjectURL;
  const revoke = environment.revokeObjectURL;
  const target = environment.document;
  if (typeof create !== 'function' || typeof target?.createElement !== 'function' || !target.body) {
    return { ok: false, filename: file.filename, message: `This browser cannot start the download. ${file.filename} was not saved.` };
  }
  let url: string | null = null;
  try {
    url = create(new Blob([file.body], { type: file.mime }));
    const anchor = target.createElement('a');
    anchor.href = url;
    anchor.download = file.filename;
    anchor.rel = 'noopener';
    target.body.append(anchor);
    anchor.click();
    anchor.remove();
    return { ok: true, filename: file.filename, message: `Started the download for ${file.filename}.` };
  } catch {
    return { ok: false, filename: file.filename, message: `The download could not start. ${file.filename} was not saved.` };
  } finally {
    const created = url;
    if (created !== null && typeof revoke === 'function') {
      const release = () => { try { revoke(created); } catch { /* the browser already released it */ } };
      // Released after the click has been dispatched, so the download keeps its bytes.
      if (typeof setTimeout === 'function') setTimeout(release, 0); else release();
    }
  }
}
