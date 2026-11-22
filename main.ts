// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format detection, JSON edits
// (section 9), the all-or-nothing write (section 10), line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------- files, lines and the three matching tiers (SPEC.md sections 3 and 5) ---------- */

interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const onlyST = (s: string): boolean => /^[ \t]*$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** Every 0-based position where O occurs in `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const n = o.length;
  if (n === 0) return out;
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence at or after `from`, with its positions (SPEC.md section 5). */
function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t).filter((i) => i >= from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: a context line (the file's own matched line, index into O) or a new line. */
type NLine = { ctx: number } | { text: string };

/**
 * The lines that replace O at `pos`: context lines are the file's own matched lines, other lines are
 * written as they are, re-indented at tier 2 (SPEC.md section 5).
 */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const f = o.length > 0 ? leadST(fileLines[pos] ?? '') : '';
  const p = o.length > 0 ? leadST(o[0]!) : '';
  const out: string[] = [];
  for (const item of n) {
    if ('ctx' in item) {
      out.push(fileLines[pos + item.ctx] ?? '');
    } else {
      const t = item.text;
      if (tier === 2 && !onlyST(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
  }
  return out;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- unified diffs (SPEC.md section 6) ---------- */

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLastCtxPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  backslashAfterLastPlus: boolean;
}

function makeHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ') {
      o.push(l === '' ? '' : l.slice(1));
      n.push({ ctx: o.length - 1 });
      lastCtxOrPlus = k;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1) });
      lastCtxOrPlus = k;
      lastPlus = k;
    }
    // a `\` line adds no line
  }
  const after = (k: number): boolean => k >= 0 && body[k + 1] !== undefined && body[k + 1]![0] === '\\';
  return { a, o, n, backslashAfterLastCtxPlus: after(lastCtxOrPlus), backslashAfterLastPlus: after(lastPlus) };
}

interface UnifiedSection {
  headerOld?: string;
  headerNew?: string;
  renameFrom?: string;
  renameTo?: string;
  diffOld?: string;
  diffNew?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: text after four characters, up to the first tab, spaces removed, one leading `a/` or `b/` removed. */
function parseDiffPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let sec: UnifiedSection | null = null;
  let inHeader = false;
  let hunk: { a: number; body: string[] } | null = null;
  const endHunk = (): void => {
    if (hunk !== null && sec !== null) {
      const body = [...hunk.body];
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec.hunks.push(makeHunk(hunk.a, body));
      hunk = null;
    }
  };
  const startSection = (diffOld?: string, diffNew?: string): void => {
    endHunk();
    sec = { newFile: false, deletedFile: false, hunks: [] };
    if (diffOld !== undefined) sec.diffOld = diffOld;
    if (diffNew !== undefined) sec.diffNew = diffNew;
    sections.push(sec);
    inHeader = true;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null || sec === null) throw new Exit2(`error: parse ${i + 1}`);
      endHunk();
      hunk = { a: Number(m[1]), body: [] };
      inHeader = false;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1], m[2]);
      continue;
    }
    // A `--- ` line followed by a `+++ ` line starts a new section, unless it is part of a section's header.
    // The pair is the new section's own header: it names the paths, so consume both lines here.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && !inHeader) {
      startSection();
      sec!.headerOld = parseDiffPath(line);
      sec!.headerNew = parseDiffPath(lines[i + 1]!);
      i += 1;
      continue;
    }
    if (sec === null) continue; // prose before any section
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (sec.headerOld === undefined) {
          sec.headerOld = parseDiffPath(line);
          sec.headerNew = parseDiffPath(lines[i + 1]!);
        }
        i += 1;
        continue;
      }
      if (line.startsWith('+++ ')) {
        if (sec.headerNew === undefined) sec.headerNew = parseDiffPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (sec.renameFrom === undefined) sec.renameFrom = line.slice(12).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (sec.renameTo === undefined) sec.renameTo = line.slice(10).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.deletedFile = true;
        continue;
      }
      continue; // index, old/new mode, similarity index, Index: and any other header line are ignored
    }
    // Body of a hunk: lines starting with ` `, `-`, `+` or `\`, or empty lines.
    if (hunk !== null && (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\')) {
      hunk.body.push(line);
      continue;
    }
    endHunk();
    // any other line outside a body is ignored (prose, code fences)
  }
  endHunk();
  return sections;
}

function applyUnifiedHunk(fm: FileModel, h: Hunk, strict: boolean, d: number, path: string): FileModel {
  const lines = fm.lines;
  if (h.o.length === 0) {
    const idx = Math.max(0, Math.min(h.a + d, lines.length));
    const repl = buildReplacement(lines, idx, [], h.n, 0);
    const out = [...lines.slice(0, idx), ...repl, ...lines.slice(idx)];
    let fin = fm.final;
    if (idx === lines.length) fin = !h.backslashAfterLastCtxPlus;
    return { lines: out, br: fm.br, final: fin };
  }
  const found = findTier(lines, h.o, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const repl = buildReplacement(lines, best, h.o, h.n, found.tier);
  const out = [...lines.slice(0, best), ...repl, ...lines.slice(best + h.o.length)];
  let fin = fm.final;
  if (best + h.o.length === lines.length) fin = !h.backslashAfterLastCtxPlus;
  return { lines: out, br: fm.br, final: fin };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const rawOld = sec.headerOld ?? sec.renameFrom ?? sec.diffOld;
    const rawNew = sec.headerNew ?? sec.renameTo ?? sec.diffNew;
    const oldPath = rawOld === undefined || rawOld === '/dev/null' ? null : rawOld;
    const newPath = rawNew === undefined || rawNew === '/dev/null' ? null : rawNew;
    return (tree: Tree): void => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      const isCreate = oldPath === null || sec.newFile;
      const isDelete = !isCreate && (newPath === null || sec.deletedFile);
      const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
      if (isCreate) {
        if (newPath === null) return;
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const outLines: string[] = [];
        for (const h of sec.hunks) {
          for (const item of h.n) {
            if ('text' in item) outLines.push(item.text);
            else outLines.push(h.o[item.ctx] ?? '');
          }
        }
        let fin = true;
        for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const h = sec.hunks[hi]!;
          if (h.n.some((item) => 'text' in item)) {
            fin = !h.backslashAfterLastPlus;
            break;
          }
        }
        tree.now.set(newPath, outLines.length === 0 ? '' : outLines.join('\n') + (fin ? '\n' : ''));
        return;
      }
      if (isDelete) {
        if (tree.get(oldPath!) === null) throw new Fail('missing', oldPath!);
        tree.now.set(oldPath!, null);
        return;
      }
      const before = tree.get(oldPath!);
      if (before === null) throw new Fail('missing', oldPath!);
      if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
      let fm = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        fm = applyUnifiedHunk(fm, h, strict, d, oldPath!);
        d += h.n.length - h.o.length;
      }
      const out = joinFile(fm);
      if (isMove) {
        tree.now.set(oldPath!, null);
        tree.now.set(newPath!, out);
        tree.moves.push([oldPath!, newPath!]);
      } else {
        tree.now.set(oldPath!, out);
      }
    };
  });
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

interface SRBlock {
  path: string;
  searchLine: number;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    blocks.push({ path, searchLine: searchIdx + 1, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const fm = splitFile(before);
    const found = findTier(fm.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const n: NLine[] = b.newLines.map((t) => ({ text: t }));
    const repl = buildReplacement(fm.lines, pos, b.oldLines, n, found.tier);
    const out = [...fm.lines.slice(0, pos), ...repl, ...fm.lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, joinFile({ lines: out, br: fm.br, final: fm.final }));
  });
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

interface V4AChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

function makeV4aChunk(cur: { anchor: string | null; body: Array<{ no: number; text: string }>; eof: boolean }): V4AChunk {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const c of cur.body) {
    const l = c.text;
    if (l === '' || l[0] === ' ') {
      o.push(l === '' ? '' : l.slice(1));
      n.push({ ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1) });
    }
  }
  return { anchor: cur.anchor, o, n, eof: cur.eof };
}

function parseV4a(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind: 'add' | 'delete' | 'update' | null = line.startsWith('*** Add File: ')
      ? 'add'
      : line.startsWith('*** Delete File: ')
        ? 'delete'
        : line.startsWith('*** Update File: ')
          ? 'update'
          : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? 14 : 17;
    const path = line.slice(prefix).trim();
    const headerLine = i + 1;
    const content: Array<{ no: number; text: string }> = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      content.push({ no: j + 1, text: l });
      j++;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const c of content) {
        if (c.text === '') addLines.push('');
        else if (c.text[0] === '+') addLines.push(c.text.slice(1));
        else throw new Exit2(`error: parse ${c.no}`);
      }
      sections.push({ kind, path, headerLine, moveTo: null, addLines, chunks: [] });
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.no}`);
      sections.push({ kind, path, headerLine, moveTo: null, addLines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
        moveTo = content[0]!.text.slice(13).trim();
        idx = 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: { anchor: string | null; body: Array<{ no: number; text: string }>; eof: boolean } | null = null;
      let chunkCount = 0;
      const endChunk = (): void => {
        if (cur !== null) {
          chunks.push(makeV4aChunk(cur));
          cur = null;
        }
      };
      for (; idx < content.length; idx++) {
        const c = content[idx]!;
        const l = c.text;
        if (l.startsWith('@@')) {
          endChunk();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunkCount++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${c.no}`);
          cur.eof = true;
          endChunk();
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunkCount > 0) throw new Exit2(`error: parse ${c.no}`);
            cur = { anchor: null, body: [], eof: false };
            chunkCount++;
          }
          cur.body.push(c);
          continue;
        }
        throw new Exit2(`error: parse ${c.no}`);
      }
      endChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, headerLine, moveTo, addLines: [], chunks });
    }
    i = j;
  }
  return sections;
}

function applyV4aChunk(fm: FileModel, ch: V4AChunk, strict: boolean, cursor: number, path: string): { fm: FileModel; cursor: number } {
  const lines = fm.lines;
  let cur = cursor;
  if (ch.anchor !== null) {
    const found = findTier(lines, [ch.anchor], cur, strict);
    if (found === null) throw new Fail('no-match', path);
    cur = found.positions[0]! + 1;
  }
  if (ch.o.length === 0) {
    const idx = ch.eof ? lines.length : cur;
    const repl: string[] = [];
    for (const item of ch.n) {
      if ('text' in item) repl.push(item.text);
    }
    const out = [...lines.slice(0, idx), ...repl, ...lines.slice(idx)];
    return { fm: { lines: out, br: fm.br, final: fm.final }, cursor: idx + repl.length };
  }
  const found = findTier(lines, ch.o, cur, strict);
  if (found === null) throw new Fail('no-match', path);
  let pos = found.positions[0]!;
  if (ch.eof) {
    const ok = found.positions.filter((p) => p + ch.o.length === lines.length);
    if (ok.length === 0) throw new Fail('no-match', path);
    pos = ok[0]!;
  }
  const repl = buildReplacement(lines, pos, ch.o, ch.n, found.tier);
  const out = [...lines.slice(0, pos), ...repl, ...lines.slice(pos + ch.o.length)];
  return { fm: { lines: out, br: fm.br, final: fm.final }, cursor: pos + repl.length };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((sec) => (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let fm = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      const r = applyV4aChunk(fm, ch, strict, cursor, sec.path);
      fm = r.fm;
      cursor = r.cursor;
    }
    const out = joinFile(fm);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  });
}

/* ---------- command line, output and exit codes (SPEC.md sections 1, 2 and 10) ---------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const tree = new Tree();
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
