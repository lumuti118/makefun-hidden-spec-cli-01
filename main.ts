// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching tiers
// (exact, trailing-whitespace-insensitive, fully-trimmed), and writes every change or
// none, printing what it changed or why it failed. SPEC.md is the whole contract.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

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

/** Shared context for the parsers: --strict, and the move pairs successful edits record. */
interface Ctx {
  strict: boolean;
  moves: { old: string; new: string }[];
}

type Edit = (tree: Tree) => void;

/** A file's lines under its own line break, and whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; ends: boolean } {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

const leading = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Occurrences of O in lines at one tier: 0-based positions, overlaps allowed. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const n = o.map((l) => norm(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (norm(lines[i + k]!, tier) !== n[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions, or null. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The first tier with an occurrence at or after `from` (end-of-file chunks only take one
 *  ending at the file's last line), or null. */
function findTierFrom(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, o, tier).filter((i) => i >= from && (!eof || i + o.length === lines.length));
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** Re-indent one new line at tier 2 (SPEC.md section 5); other tiers write it as it is. */
function reindent(text: string, tier: number, p: string, f: string): string {
  if (tier !== 2) return text;
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  return text.startsWith(p) ? f + text.slice(p.length) : text;
}

/** One body line of a unified hunk or a V4A chunk. `empty` marks a context line that
 *  came from a bare empty patch line (those are stripped at the end of a unified body). */
type BodyItem =
  | { kind: 'ctx'; text: string; empty: boolean }
  | { kind: 'old'; text: string }
  | { kind: 'new'; text: string }
  | { kind: 'mark' };

function bodyItem(line: string): BodyItem {
  if (line === '') return { kind: 'ctx', text: '', empty: true };
  if (line[0] === ' ') return { kind: 'ctx', text: line.slice(1), empty: false };
  if (line[0] === '-') return { kind: 'old', text: line.slice(1) };
  if (line[0] === '+') return { kind: 'new', text: line.slice(1) };
  return { kind: 'mark' };
}

/** O (context + old lines) and the resolved N for a body, given the file's matched lines. */
function resolveBody(
  items: BodyItem[],
  fileLines: string[],
  pos: number,
  tier: number,
): { o: string[]; n: string[] } {
  const o: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx' || it.kind === 'old') o.push(it.text);
  }
  const p = o.length > 0 ? leading(o[0]!) : '';
  const f = o.length > 0 ? leading(fileLines[pos] ?? '') : '';
  const n: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      n.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'old') {
      oi += 1;
    } else if (it.kind === 'new') {
      n.push(reindent(it.text, tier, p, f));
    }
  }
  return { o, n };
}

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

/* ------------------------------------------------------------------ JSON (section 9) */

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

/* ------------------------------------------------------- Unified diffs (section 6) */

interface Hunk {
  a: number;
  items: BodyItem[];
  noNL: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseDiffGit(line: string, num: number): { x: string; y: string } {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${num}`);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new Exit2(`error: parse ${num}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${num}`);
  return { x, y };
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** Strip one leading `a/` or `b/` from a ---/+++ path. */
function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Apply a section's hunks, in order, to a file's text. Throws Fail('no-match', path). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const { lines, br, ends: ends0 } = splitFile(text);
  let ends = ends0;
  let d = 0;
  for (const h of hunks) {
    const probe = resolveBody(h.items, lines, 0, 0);
    const o = probe.o;
    if (o.length > 0) {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const q of found.occ) {
        const dist = Math.abs(q - target);
        if (dist < best) {
          best = dist;
          pos = q;
        }
      }
      const { n } = resolveBody(h.items, lines, pos, found.tier);
      const toEnd = pos + o.length === lines.length;
      lines.splice(pos, o.length, ...n);
      if (toEnd) ends = !h.noNL;
      d += n.length - o.length;
    } else {
      const { n } = resolveBody(h.items, lines, 0, 0);
      let ins = h.a + d;
      if (ins < 0) ins = 0;
      if (ins > lines.length) ins = lines.length;
      const atEnd = ins === lines.length;
      lines.splice(ins, 0, ...n);
      if (atEnd) ends = !h.noNL;
      d += n.length;
    }
  }
  return joinFile(lines, br, ends);
}

interface Section {
  /** Paths from the ---/+++ pair, the rename lines, and the diff --git line, in that
   *  precedence (SPEC.md section 6): rename names a path only when no ---/+++ pair does,
   *  and the diff --git paths are used when nothing else names one. */
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string;
  diffNew: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], ctx: Ctx): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const { x, y } = parseDiffGit(line, i + 1);
      const sec: Section = {
        pairOld: null,
        pairNew: null,
        renameOld: null,
        renameNew: null,
        diffOld: x,
        diffNew: y,
        create: false,
        del: false,
        hunks: [],
      };
      sections.push(sec);
      i = parseSection(lines, i + 1, sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = {
        pairOld: null,
        pairNew: null,
        renameOld: null,
        renameNew: null,
        diffOld: '',
        diffNew: '',
        create: false,
        del: false,
        hunks: [],
      };
      sections.push(sec);
      i = parseSection(lines, i, sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((sec) => unifiedEdit(sec, ctx));
}

/** Parse one section's header and hunks, starting at `start`; return the index after it. */
function parseSection(lines: string[], start: number, sec: Section): number {
  const n = lines.length;
  let i = start;
  let inHunks = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (!inHunks && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec.pairOld === null) {
        sec.pairOld = stripPrefix(headerPath(line));
        sec.pairNew = stripPrefix(headerPath(lines[i + 1]!));
      }
      i += 2;
      continue;
    }
    if (inHunks && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      inHunks = true;
      i += 1;
      // Hunk body.
      const items: BodyItem[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          items.push(bodyItem(l));
          i += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          items.push(bodyItem(l));
          i += 1;
          continue;
        }
        break;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.empty) items.pop();
        else break;
      }
      let noNL = false;
      for (let k = items.length - 1; k >= 0; k -= 1) {
        const it = items[k]!;
        if (it.kind === 'ctx' || it.kind === 'new') {
          noNL = items[k + 1]?.kind === 'mark';
          break;
        }
      }
      sec.hunks.push({ a, items, noNL });
      continue;
    }
    if (!inHunks) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ') && sec.renameOld === null) {
        sec.renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ') && sec.renameNew === null) {
        sec.renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        sec.create = true;
      } else if (line.startsWith('deleted file mode')) {
        sec.del = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function unifiedEdit(sec: Section, ctx: Ctx): Edit {
  const oldPath = sec.pairOld ?? sec.renameOld ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.renameNew ?? sec.diffNew;
  const isCreate = oldPath === '/dev/null' || sec.create;
  const isDelete = newPath === '/dev/null' || sec.del;
  if (isCreate) {
    return (tree) => {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.items) if (it.kind === 'new') out.push(it.text);
      }
      let ends = false;
      if (out.length > 0) {
        let lastNoNL = false;
        for (let k = sec.hunks.length - 1; k >= 0; k -= 1) {
          const h = sec.hunks[k]!;
          if (h.items.some((it) => it.kind === 'new')) {
            lastNoNL = h.noNL;
            break;
          }
        }
        ends = !lastNoNL;
      }
      tree.now.set(newPath, out.length === 0 ? '' : out.join('\n') + (ends ? '\n' : ''));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (oldPath !== newPath) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const text = applyHunks(before, sec.hunks, ctx.strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, text);
      ctx.moves.push({ old: oldPath, new: newPath });
    };
  }
  return (tree) => {
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(before, sec.hunks, ctx.strict, oldPath));
  };
}

/* --------------------------------------------- SEARCH/REPLACE blocks (section 7) */

function parseSearchReplace(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const sIdx = i;
      let path: string | null = null;
      for (let j = sIdx - 1; j >= prevEnd; j -= 1) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
        path = prevPath;
      }
      let eq = -1;
      let gt = -1;
      for (let j = sIdx + 1; j < n; j += 1) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          eq = j;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      for (let j = eq + 1; j < n; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          gt = j;
          break;
        }
      }
      if (gt < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
      const oldLines = lines.slice(sIdx + 1, eq);
      const newLines = lines.slice(eq + 1, gt);
      edits.push(searchReplaceEdit(path, oldLines, newLines, ctx));
      prevPath = path;
      prevEnd = gt + 1;
      i = gt + 1;
    } else {
      i += 1;
    }
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], ctx: Ctx): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const { lines, br, ends } = splitFile(cur);
    const found = findTier(lines, oldLines, ctx.strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const p = leading(oldLines[0]!);
    const f = leading(lines[pos]!);
    const repl = newLines.map((t) => reindent(t, found.tier, p, f));
    lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(lines, br, ends));
  };
}

/* ---------------------------------------------------------- V4A patches (section 8) */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function parseV4A(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const startNum = i + 1;
    const kind = line.startsWith('*** Add File:')
      ? 'add'
      : line.startsWith('*** Delete File:')
        ? 'delete'
        : 'update';
    const path = line.slice(line.indexOf(':') + 1).trim();
    const raw: { text: string; num: number }[] = [];
    i += 1;
    while (i < last && !isStart(lines[i]!)) {
      raw.push({ text: lines[i]!, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    edits.push(v4aEdit(kind, path, raw, startNum, ctx));
  }
  return edits;
}

function v4aEdit(
  kind: string,
  path: string,
  raw: { text: string; num: number }[],
  startNum: number,
  ctx: Ctx,
): Edit {
  if (kind === 'add') {
    const out: string[] = [];
    for (const r of raw) {
      if (r.text === '') out.push('');
      else if (r.text.startsWith('+')) out.push(r.text.slice(1));
      else throw new Exit2(`error: parse ${r.num}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update File.
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
    moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  let seenChunk = false;
  for (; idx < raw.length; idx += 1) {
    const r = raw[idx]!;
    const l = r.text;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      cur = { anchor: l.slice(2).trim(), eof: false, items: [] };
      seenChunk = true;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l.startsWith('***')) throw new Exit2(`error: parse ${r.num}`);
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (!seenChunk) {
          cur = { anchor: null, eof: false, items: [] };
          seenChunk = true;
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      cur.items.push(bodyItem(l));
      continue;
    }
    throw new Exit2(`error: parse ${r.num}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startNum}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { lines, br, ends } = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let found = -1;
        const tiers = ctx.strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (norm(lines[k]!, tier) === norm(ch.anchor!, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { o } = resolveBody(ch.items, lines, cursor, 0);
      if (o.length > 0) {
        const found = findTierFrom(lines, o, cursor, ctx.strict, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const { n } = resolveBody(ch.items, lines, pos, found.tier);
        lines.splice(pos, o.length, ...n);
        cursor = pos + n.length;
      } else {
        const { n } = resolveBody(ch.items, lines, cursor, 0);
        const ins = ch.eof ? lines.length : cursor;
        lines.splice(ins, 0, ...n);
        cursor = ins + n.length;
      }
    }
    const text = joinFile(lines, br, ends);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      ctx.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

/* ------------------------------------------------------------------ Run (sections 1, 2, 10) */

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
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, ctx);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, ctx);
    else edits = parseV4A(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const m of ctx.moves) {
    if (tree.original(m.old) !== null && tree.original(m.new) === null && finalOf(m.old) === null && finalOf(m.new) !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
