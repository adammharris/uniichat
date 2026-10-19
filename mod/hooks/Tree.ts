// Tree
// ====
// UniiChat's memory (Memory.ts) for a Claude Code mod: the chat's messages,
// the binary tree of their summaries and the two views over it, ported as
// closely as the mod's environment lets. Read Memory.ts's header first; the
// algorithms are its own (the tree, the order nodes build in, a line too
// long asked anew, the views' merges by due, a view changing only at its
// end between batches, the blocks a call marks). What differs:
//
// - one side: no imports, so no `sides`, no `hold`, no billing;
// - files go through an Io (the mod's $.fs: async, whole files of at most
//   4 MiB), so messages are logged in files of CHUNK and read a file at a
//   time, and nodes in files of NODES records; every node built stays in
//   memory (Memory.ts keeps only its views' and reads the rest by index);
// - a compaction's call goes through the Io (the mod's $.model.complete),
//   whole, not streamed: single flight lets those waiting go when the
//   leader's call ends, not as its response begins;
// - a source's text is read async (a message from its file), so pump runs
//   one at a time (`pumping`), and again if asked meanwhile.

// Types
// =====

// the user's, an agent's reply, its tool call, the call's result, a
// background task's report, a note
export type Kind = "user" | "agent" | "tool" | "echo" | "work" | "note";

// a message to log; no date: now
export type Msg = { kind: Kind; text: string; date?: string };

// a message (a page) as logged
export type Root = { i: number; kind: Kind; text: string; date: string; size: number };

// node (l,i), as a line of a view
export type Part = { l: number; i: number };

// a view: its lines, the bytes of those built, a batch under way, the bytes
// past which it merges to half
export type View = { parts: Part[]; size: number; batch: boolean; high: number };

// a text block of a call's message; `mark`: a cache entry ends after it
export type Block = { text: string; mark: boolean };

// a compaction's call: its line, or why none (refused: its input's doing,
// never asked again; else asked again AGAIN later)
export type Answer = { ok: true; text: string } | { ok: false; refused: boolean; text: string };

// what the tree reads, writes and asks through (paths relative to its dir)
export type Io = {
  read  : (path: string) => Promise<string | null>;
  write : (path: string, text: string) => Promise<void>;
  ask   : (blocks: Block[]) => Promise<Answer>;
  now   : () => number;
  sleep : (ms: number) => Promise<void>;
  error : (text: string) => void;
};

// a cache entry: writing (ready: settles once written) or live till `until`
type Cached = { until: number; ready: Promise<void> | null };

// a view in state.json
type Kept = { parts: Array<[number, number]>; batch: boolean };

// state.json: the count, the chat's view, the compactions'
type Saved = Kept & { count: number; seen: Kept };

// chunks: message files read, by number, oldest read first; nodes: every
// node built, by slot; logged: nodes logged; last: the last node file's
// lines; ready: the nodes not built whose halves are, by level, in order;
// busy: nodes building; cache: prefixes cached (single flight); wait:
// checks run as the views change; writes: the files' writes, in order
export type Tree = {
  io      : Io;
  count   : number;
  chunks  : Map<number, Root[]>;
  nodes   : Map<number, string>;
  logged  : number;
  last    : string[];
  view    : View;
  seen    : View;
  ready   : number[][];
  busy    : Set<number>;
  cache   : Map<string, Cached>;
  wait    : Set<() => void>;
  done    : boolean;
  pumping : boolean;
  again   : boolean;
  writes  : Promise<void>;
  made?   : () => void;
};

// Constants
// =========

export const NODE = 512;
export const JOBS = 64;
const TRIES = 5;
// a view past its `high` merges to half: the chat's 64-128 KB (96 KB on
// average), the compactions' 16-32 KB (24 KB)
export const HIGH = 128000;
export const SEEN = 32000;
const BLOCK = 4;

// the most text a message holds: a longer one goes in pages (Clip.ts)
export const CAP = 30000;

// messages a file, nodes a file: CHUNK pages of CAP characters stay under
// $.fs's 4 MiB however they encode
const CHUNK = 16;
const NODES = 1024;

// message files kept read
const CHUNKS = 64;

// how long a call waits to ask again after a failure, and how long the
// vendor keeps a cache entry unused (AskAI.ts)
const AGAIN = 60e3;
const TTL = 300e3;

// a ruler, not a sample line: the compactor copied a sample's content
const SCALE = "-".repeat(NODE);

export const WAIT = "(not summarized yet: zoom it)";

// a compaction's task, before its <input>: one message to compress
// (level 0), or two lines to merge
const LEAF = `Compaction: compress message {id} into one line of at most ${NODE} bytes
(about 70 words), the length of this ruler:
${SCALE}
<input>
`;

const MERGE = `Compaction: merge lines {a} and {b}, adjacent, into one line of at most
${NODE} bytes (about 70 words), the length of this ruler:
${SCALE}
<chat> may hold their messages, {id} to {end}, in more detail: take details
of them from there too.
<input>
`;

const UTF8 = new TextEncoder();
const UTF8_OUT = new TextDecoder();

// Tree
// ====

export namespace Tree {

  export async function load(io: Io): Promise<Tree> {
    const t: Tree = {
      io, count: 0, chunks: new Map(), nodes: new Map(), logged: 0, last: [], ready: [], busy: new Set(), cache: new Map(), wait: new Set(),
      view: { parts: [], size: 0, batch: false, high: HIGH }, seen: { parts: [], size: 0, batch: false, high: SEEN },
      done: false, pumping: false, again: false, writes: Promise.resolve(),
    };
    const saved = Tree.parse(await io.read("state.json")) as Saved | null;
    t.count = saved?.count ?? 0;
    for (let k = 0; ; k++) {
      const text = await io.read("tree/" + k + ".jsonl");
      if (text === null) {
        break;
      }
      const lines = text.split("\n").filter((line) => line !== "");
      for (const line of lines) {
        const rec = Tree.parse(line);
        if (rec !== null && Tree.span(rec)[1] < t.count) {
          t.nodes.set(Tree.slot(rec.l, rec.i), rec.text);
        }
      }
      t.logged += lines.length;
      t.last = lines.length < NODES ? lines : [];
    }
    if (t.count > 0) {
      await Tree.message(t, t.count - 1);
    }
    Tree.open(t, t.view, saved);
    Tree.open(t, t.seen, saved?.seen ?? saved);
    Tree.roots(t.count).flatMap((part) => Tree.todo(t, part)).forEach((part) => Tree.ready(t, part, true));
    Tree.fit(t);
    Tree.save(t);
    Tree.pump(t);
    return t;
  }

  export function parse(text: string | null): any {
    try {
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  }

  // a view as kept (none: the highest nodes built)
  export function open(t: Tree, view: View, kept: Kept | null): void {
    const keys = kept === null ? null : new Set(kept.parts.map(([l, i]) => Tree.slot(l, i)));
    view.parts = Tree.roots(t.count).flatMap((part) => Tree.down(t, part, keys));
    view.size = view.parts.reduce((n, part) => n + Tree.size(t, part), 0);
    view.batch = kept?.batch ?? false;
  }

  export function save(t: Tree): void {
    const [chat, seen] = [t.view, t.seen].map((view): Kept => ({ parts: view.parts.map((part) => [part.l, part.i]), batch: view.batch }));
    const saved: Saved = { ...chat!, seen: seen!, count: t.count };
    Tree.write(t, "state.json", JSON.stringify(saved));
  }

  // a file written after those asked before it
  export function write(t: Tree, path: string, text: string): void {
    t.writes = t.writes.then(() => t.io.write(path, text)).catch((err) => t.io.error("write " + path + ": " + (err?.message ?? err)));
  }

  export function slot(l: number, i: number): number {
    return (2 * i + 1) * 2 ** l - 1;
  }

  export function bytes(text: string): number {
    return UTF8.encode(text).length;
  }

  // Messages
  // --------

  export function root(i: number, msg: Msg): Root {
    const root: Root = { i, kind: msg.kind, text: Tree.well(msg.text), date: msg.date!, size: 0 };
    root.size = Tree.bytes(Tree.show(root));
    return root;
  }

  // a text with each lone surrogate replaced (String.toWellFormed)
  export function well(text: string): string {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
  }

  // a message as models read it, tagged by its author
  export function show(root: Root): string {
    return root.kind + ": " + root.text;
  }

  // message i, from its file; null: none
  export async function message(t: Tree, i: number): Promise<Root | null> {
    if (!Number.isInteger(i) || i < 0 || i >= t.count) {
      return null;
    }
    const k = Math.floor(i / CHUNK);
    let chunk = t.chunks.get(k);
    if (chunk === undefined) {
      const text = await t.io.read("main/" + k + ".jsonl");
      chunk = (text ?? "").split("\n").filter((line) => line !== "").map((line) => Tree.parse(line)).filter((root) => root !== null && root.i < t.count);
      Tree.keep(t, k, chunk);
    }
    return chunk.find((root) => root.i === i) ?? null;
  }

  // a message file read, kept; the oldest read let go past CHUNKS, but
  // never the one messages are logged to
  export function keep(t: Tree, k: number, chunk: Root[]): void {
    t.chunks.set(k, chunk);
    for (const old of t.chunks.keys()) {
      if (t.chunks.size <= CHUNKS) {
        break;
      }
      if (old !== Math.floor(t.count / CHUNK) && old !== Math.floor((t.count - 1) / CHUNK)) {
        t.chunks.delete(old);
      }
    }
  }

  // the messages logged, a long one in pages; each a leaf ready to build
  export function push(t: Tree, msgs: Msg[]): Root[] {
    const now = new Date(t.io.now()).toISOString();
    const roots = msgs.flatMap(Tree.pages).map((msg, k) => Tree.root(t.count + k, { ...msg, date: msg.date ?? now }));
    const files = new Set<number>();
    for (const root of roots) {
      const k = Math.floor(root.i / CHUNK);
      const chunk = t.chunks.get(k) ?? [];
      chunk.push(root);
      t.chunks.set(k, chunk);
      files.add(k);
    }
    t.count += roots.length;
    files.forEach((k) => Tree.write(t, "main/" + k + ".jsonl", t.chunks.get(k)!.map((root) => JSON.stringify(root) + "\n").join("")));
    roots.forEach((root) => Tree.ready(t, { l: 0, i: root.i }, true));
    Tree.save(t);
    Tree.fit(t, true);
    Tree.pump(t);
    return roots;
  }

  // a message in pages of CAP characters
  export function pages(msg: Msg): Msg[] {
    return Tree.clip_pages(msg.text).map((text) => ({ ...msg, text }));
  }

  // where the page of a text from `at` ends: CAP characters on, after its
  // last newline if it has one, else where a character ends (Clip.ts)
  export function clip_end(str: string, at: number): number {
    if (str.length - at <= CAP) {
      return str.length;
    }
    const nl  = str.lastIndexOf("\n", at + CAP - 1);
    const low = str.charCodeAt(at + CAP) >> 10 === 0x37;
    return nl >= at ? nl + 1 : at + CAP - (low ? 1 : 0);
  }

  export function clip_pages(str: string): string[] {
    const pages: string[] = [];
    let at = 0;
    do {
      const end = Tree.clip_end(str, at);
      pages.push(str.slice(at, end));
      at = end;
    } while (at < str.length);
    return pages;
  }

  // a text's page from `at`, and past it where to go on
  export function clip_page(str: string, at: number): string {
    const end = Tree.clip_end(str, at);
    const on  = "\n[characters " + (at + 1) + "-" + end + " of " + str.length + "; go on with at " + end + "]";
    return str.slice(at, end) + (end < str.length ? on : "");
  }

  // Nodes
  // -----

  export function built(t: Tree, l: number, i: number): boolean {
    return t.nodes.has(Tree.slot(l, i));
  }

  // the tree's roots: a node per power of two in the count, largest first
  export function roots(count: number): Part[] {
    const out: Part[] = [];
    for (let l = 30, id = 0; l >= 0; l--) {
      if (id + 2 ** l <= count) {
        out.push({ l, i: id / 2 ** l });
        id += 2 ** l;
      }
    }
    return out;
  }

  // the view under `part`, down from it, keeping the built nodes met: the
  // nodes of `keys` built (none: any built), or messages
  export function down(t: Tree, part: Part, keys: Set<number> | null): Part[] {
    const key = Tree.slot(part.l, part.i);
    if (part.l === 0 || (t.nodes.has(key) && (keys === null || keys.has(key)))) {
      return [part];
    }
    return Tree.halves(part).flatMap((half) => Tree.down(t, half, keys));
  }

  export function halves(part: Part): Part[] {
    return part.l === 0 ? [] : [{ l: part.l - 1, i: 2 * part.i }, { l: part.l - 1, i: 2 * part.i + 1 }];
  }

  // what node (l,i) is made from: its message, or its halves' lines
  export async function source(t: Tree, l: number, i: number): Promise<string | null> {
    if (l === 0) {
      const root = await Tree.message(t, i);
      return root === null ? null : Tree.show(root);
    }
    const [a, b] = Tree.halves({ l, i }).map((half) => t.nodes.get(Tree.slot(half.l, half.i)) ?? null);
    return a == null || b == null ? null : Tree.flat(a) + "\n" + Tree.flat(b);
  }

  // the messages before node (l,i)'s end: what its compaction's view holds
  export function ctx(l: number, i: number): number {
    return l === 0 ? i : (i + 1) * 2 ** l;
  }

  // the message of the view's (k+1)th line not built, else the count
  export function first(t: Tree, k = 0): number {
    return (t.ready[0] ?? [])[k] ?? t.count;
  }

  // a node ready (on), or no more (built)
  export function ready(t: Tree, { l, i }: Part, on: boolean): void {
    const queue = (t.ready[l] ??= []);
    let [a, z] = [0, queue.length];
    while (a < z) {
      const m = (a + z) >> 1;
      [a, z] = queue[m]! < i ? [m + 1, z] : [a, m];
    }
    if (on !== (queue[a] === i)) {
      queue.splice(a, on ? 0 : 1, ...(on ? [i] : []));
    }
  }

  // the nodes under `part` not built whose sources are
  export function todo(t: Tree, part: Part): Part[] {
    if (Tree.built(t, part.l, part.i)) {
      return [];
    }
    const halves = Tree.halves(part);
    const here = halves.every((half) => Tree.built(t, half.l, half.i)) ? [part] : [];
    return [...here, ...halves.flatMap((half) => Tree.todo(t, half))];
  }

  // the nodes to build; those whose source fits take no call: built at
  // once, together. One pump at a time; asked meanwhile, it goes again
  export function pump(t: Tree): void {
    if (t.pumping) {
      t.again = true;
      return;
    }
    t.pumping = true;
    t.again = false;
    const run = async () => {
      let built = false;
      for (let free = await Tree.starts(t); free.length > 0 && !t.done; free = await Tree.starts(t)) {
        Tree.store(t, free);
        built = true;
      }
      if (built) {
        Tree.fit(t);
      }
    };
    run().catch((err) => t.io.error("pump: " + (err?.message ?? err))).finally(() => {
      t.pumping = false;
      if (t.again && !t.done) {
        Tree.pump(t);
      }
    });
  }

  // the nodes ready up to the JOBS-th line not built, in the order the
  // messages came (`ctx`; at a tie, a merge first), while JOBS run. The
  // jobs started; the nodes whose source fits
  export async function starts(t: Tree): Promise<Array<Part & { text: string }>> {
    const free: Array<Part & { text: string }> = [];
    const end = Tree.first(t, JOBS - 1);
    const next: Part[] = [];
    t.ready.forEach((queue, l) => {
      for (let k = 0; k < queue.length && Tree.ctx(l, queue[k]!) <= end; k++) {
        next.push({ l, i: queue[k]! });
      }
    });
    next.sort((a, b) => Tree.ctx(a.l, a.i) - Tree.ctx(b.l, b.i) || b.l - a.l);
    for (const { l, i } of next) {
      if (t.done || t.busy.size >= JOBS) {
        break;
      }
      const text = t.busy.has(Tree.slot(l, i)) ? null : await Tree.source(t, l, i);
      if (text !== null && Tree.bytes(text) <= NODE) {
        free.push({ l, i, text });
      } else if (text !== null) {
        Tree.job(t, l, i, text);
      }
    }
    return free;
  }

  export function job(t: Tree, l: number, i: number, text: string): void {
    const key = Tree.slot(l, i);
    t.busy.add(key);
    Tree.build(t, l, i, text).finally(() => {
      t.busy.delete(key);
      Tree.pump(t);
      Tree.fit(t);
    }).catch((err) => {
      t.io.error("compactor: node " + l + "/" + i + ": " + (err?.message ?? err));
    });
  }

  // node (l,i)'s summary: its view to the node and its task, asked till a
  // line fits, TRIES lines at most, the shortest kept. Each try sends those
  // blocks, never a try's words; one after a line too long adds only its
  // size and where the limit cuts it (`over`). No line (a refusal): its
  // source clipped; a try cut (the tree stopped) throws, unless a line came
  export async function build(t: Tree, l: number, i: number, text: string): Promise<void> {
    const task = { text: Tree.task(l, i) + text + "\n</input>", mark: false };
    const upto = Math.min(Tree.ctx(l, i), Tree.first(t, 0));
    const blocks = [...Tree.view(t, upto, t.seen.parts), task];
    const lines: string[] = [];
    let end = await Tree.ask(t, blocks);
    while (end.ok && end.text.trim() !== "") {
      const line = end.text.trim();
      lines.push(line);
      if (Tree.bytes(line) <= NODE || lines.length === TRIES || t.done) {
        break;
      }
      end = await Tree.ask(t, [...blocks, { text: Tree.over(line), mark: false }]);
    }
    if (lines.length === 0 && !end.ok && !end.refused) {
      throw new Error(end.text);
    }
    if (lines.length === 0) {
      t.io.error("compactor: node " + l + "/" + i + ": " + (end.ok ? "an empty line" : end.text) + "; clipped");
    }
    const line = lines.length === 0 ? Tree.cut(Tree.flat(text)) : lines.reduce((a, b) => (Tree.bytes(b) < Tree.bytes(a) ? b : a));
    Tree.store(t, [{ l, i, text: line }]);
  }

  // a call, asked again AGAIN after each failure that isn't a refusal,
  // till answered or the tree stops (AskAI patient)
  export async function ask(t: Tree, blocks: Block[]): Promise<Answer> {
    for (;;) {
      const flight = await Tree.wait(t, blocks);
      const end: Answer = await t.io.ask(blocks).catch((err) => ({ ok: false, refused: false, text: String(err?.message ?? err) }));
      flight(end.ok);
      if (end.ok || end.refused || t.done) {
        return end;
      }
      await t.io.sleep(AGAIN);
    }
  }

  // nodes built: logged in one write, kept
  export function store(t: Tree, parts: Array<Part & { text: string }>): void {
    Tree.log(t, parts.map(({ l, i, text }) => ({ l, i, text, size: Tree.bytes(text) })));
    for (const { l, i, text } of parts) {
      Tree.ready(t, { l, i }, false);
      t.nodes.set(Tree.slot(l, i), text);
      [t.view, t.seen].forEach((view) => (view.size += l === 0 && i < Tree.end(view) ? Tree.bytes(text) : 0));
    }
    for (const { l, i } of parts) {
      const up = { l: l + 1, i: i >> 1 };
      if (Tree.built(t, l, i ^ 1) && !Tree.built(t, up.l, up.i)) {
        Tree.ready(t, up, true);
      }
    }
    t.made?.();
  }

  // nodes logged to the last node file, a full one written as it fills
  export function log(t: Tree, recs: object[]): void {
    recs.forEach((rec, k) => {
      const file = Math.floor(t.logged / NODES);
      t.last.push(JSON.stringify(rec));
      t.logged += 1;
      if (t.last.length === NODES || k === recs.length - 1) {
        Tree.write(t, "tree/" + file + ".jsonl", t.last.join("\n") + "\n");
      }
      if (t.last.length === NODES) {
        t.last = [];
      }
    });
  }

  // node (l,i)'s task, but its input
  export function task(l: number, i: number): string {
    const [a, z] = Tree.span({ l, i });
    const n = 2 ** l / 2;
    const fill: Array<[string, string]> = [["{a}", a + "+" + n], ["{b}", a + n + "+" + n], ["{id}", String(a)], ["{end}", String(z)]];
    return fill.reduce((text, [k, v]) => text.replace(k, v), l === 0 ? LEAF : MERGE);
  }

  // a text's first NODE bytes
  export function cut(text: string): string {
    return UTF8_OUT.decode(UTF8.encode(text).subarray(0, NODE)).replace(/�+$/, "");
  }

  export function over(line: string): string {
    return `Too long: your last line for this <input> was ${Tree.bytes(line)} bytes,
over the ${NODE}-byte limit. Write the whole line again, cutting just
enough of the least valuable items to fit before this cut:
${Tree.cut(line)}| ← LIMIT`;
  }

  // Single flight
  // -------------

  // the keys of a call's prefix at each block end through its last mark
  // before its end, each block's hash seeded by the one before
  export function keys(blocks: Block[]): string[] {
    const last = blocks.slice(0, -1).findLastIndex((b) => b.mark);
    let key = "";
    return blocks.slice(0, last + 1).map((b) => (key = Tree.hash(key + "\u0000" + b.text)));
  }

  // FNV-1a, twice (two seeds): 64 bits as hex
  export function hash(text: string): string {
    let [a, b] = [0x811c9dc5, 0x01000193 ^ 0x5bd1e995];
    for (let k = 0; k < text.length; k++) {
      const c = text.charCodeAt(k);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    }
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
  }

  // waits while a leader writes the longest cached part of the call's
  // prefix; then leads, unless its whole prefix is cached. Answers what
  // ends the call: told whether it answered (its prefix then cached)
  export async function wait(t: Tree, blocks: Block[]): Promise<(ok: boolean) => void> {
    const keys = Tree.keys(blocks);
    for (;;) {
      const now = t.io.now();
      const live = (key: string) => {
        const c = t.cache.get(key);
        return c !== undefined && (c.ready !== null || c.until > now);
      };
      const k = keys.findLastIndex(live);
      const got = k < 0 ? null : t.cache.get(keys[k]!)!;
      if (got?.ready) {
        await got.ready;
        continue;
      }
      if (got !== null) {
        got.until = now + TTL;
        t.cache.delete(keys[k]!);
        t.cache.set(keys[k]!, got);
      }
      if (k === keys.length - 1) {
        return () => {};
      }
      return Tree.lead(t, keys[keys.length - 1]!, now);
    }
  }

  // the call writing `key`; old entries go as a new one comes, the least
  // lately used first, up to the first still live
  export function lead(t: Tree, key: string, now: number): (ok: boolean) => void {
    for (const [k, c] of t.cache) {
      if (c.ready !== null || c.until >= now) {
        break;
      }
      t.cache.delete(k);
    }
    let free = () => {};
    const own: Cached = { until: 0, ready: new Promise((ok) => (free = ok)) };
    t.cache.set(key, own);
    return (ok) => {
      if (own.ready === null) {
        return;
      }
      own.ready = null;
      if (ok) {
        own.until = t.io.now() + TTL;
      } else {
        t.cache.delete(key);
      }
      free();
    };
  }

  // View
  // ----

  // of the view or a node above it: built, or not yet
  export function text(t: Tree, part: Part): string {
    return t.nodes.get(Tree.slot(part.l, part.i)) ?? WAIT;
  }

  // a line's bytes as calls get it: none until built
  export function size(t: Tree, part: Part): number {
    return Tree.built(t, part.l, part.i) ? Tree.bytes(Tree.text(t, part)) : 0;
  }

  // each view to its end; a batch starts as a view passes `high`, or goes
  // on at a message (`next`) if a missing parent stopped it; between
  // messages, only a whole batch, to half or, as parents not built keep it
  // over, by `high`: each change makes every call after write the view anew
  export function fit(t: Tree, next = false): void {
    let changed = false;
    Tree.reach(t, t.view, t.count);
    Tree.reach(t, t.seen, Math.min(t.count, Tree.first(t, 0)));
    for (const view of [t.view, t.seen]) {
      const [parts, batch] = [view.parts.length, view.batch];
      if (view.size > view.high || (next && view.batch)) {
        const merged = Tree.merge(t, view);
        if (next || merged.size <= Math.max(view.high / 2, view.size - view.high)) {
          [view.parts, view.size] = [merged.parts, merged.size];
        }
        view.batch = view.size > view.high / 2;
      }
      changed ||= view.parts.length !== parts || view.batch !== batch;
    }
    if (changed) {
      Tree.save(t);
    }
    t.wait.forEach((check) => check());
    t.made?.();
  }

  // a view to message `end`: its lines from it dropped, the messages to it
  // appended
  export function reach(t: Tree, view: View, end: number): void {
    for (const part of view.parts.splice(Tree.cover(view, end))) {
      view.size -= Tree.size(t, part);
    }
    for (let i = Tree.end(view); i < end; i++) {
      view.parts.push({ l: 0, i });
      view.size += Tree.size(t, { l: 0, i });
    }
  }

  // the message after a view's last line
  export function end({ parts }: View): number {
    return parts.length === 0 ? 0 : Tree.span(parts[parts.length - 1]!)[1] + 1;
  }

  // the index of a view's line holding message id (past its end: none)
  export function cover({ parts }: View, id: number): number {
    let [a, z] = [0, parts.length];
    while (a < z) {
      const m = (a + z) >> 1;
      [a, z] = Tree.span(parts[m]!)[1] < id ? [m + 1, z] : [a, m];
    }
    return a;
  }

  // a view's most due pairs merged down to half, as their parents allow: a
  // pair whose parent is built, most due first ((T + 1) / 2^l - i, T the
  // view's end: its age from its last message, in halves), the oldest of
  // equals; a heap of pairs over the view as a linked list
  export function merge(t: Tree, from: View): { parts: Part[]; size: number } {
    const [end, low] = [Tree.end(from), from.high / 2];
    const view: Array<Part | null> = [...from.parts];
    const next = view.map((_, k) => k + 1);
    const prev = view.map((_, k) => k - 1);
    type Pair = { d: number; k: number; a: Part; b: Part };
    const heap: Pair[] = [];
    const over = (x: Pair, y: Pair) => x.d > y.d || (x.d === y.d && x.k < y.k);
    const swap = (x: number, y: number) => ([heap[x], heap[y]] = [heap[y]!, heap[x]!]);
    const offer = (k: number) => {
      const [a, b] = [view[k], view[next[k]!]];
      if (k < 0 || !a || !b || a.i % 2 !== 0 || b.l !== a.l || b.i !== a.i + 1 || !Tree.built(t, a.l + 1, a.i / 2)) {
        return;
      }
      heap.push({ d: (end + 1) / 2 ** a.l - a.i, k, a, b });
      for (let x = heap.length - 1; x > 0 && over(heap[x]!, heap[(x - 1) >> 1]!); x = (x - 1) >> 1) {
        swap(x, (x - 1) >> 1);
      }
    };
    const take = () => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        for (let x = 0; ; ) {
          const m = [x, 2 * x + 1, 2 * x + 2].reduce((m, c) => (c < heap.length && over(heap[c]!, heap[m]!) ? c : m));
          if (m === x) {
            break;
          }
          swap(x, m);
          x = m;
        }
      }
      return top;
    };
    let size = from.size;
    view.forEach((_, k) => offer(k));
    while (heap.length > 0 && size > low) {
      const { k, a, b } = take();
      const j = next[k]!;
      if (view[k] !== a || view[j] !== b) {
        continue;
      }
      const up = { l: a.l + 1, i: a.i / 2 };
      size += Tree.size(t, up) - Tree.size(t, a) - Tree.size(t, b);
      [view[k], view[j]] = [up, null];
      next[k] = next[j]!;
      prev[next[j]!] = k;
      offer(prev[k]!);
      offer(k);
    }
    return { parts: view.filter((part) => part !== null), size };
  }

  // once the messages before `end` are built; false: stopped first
  export function settle(t: Tree, end: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const check = () => {
        const built = Tree.first(t) >= end;
        if (built || signal?.aborted || t.done) {
          t.wait.delete(check);
          signal?.removeEventListener("abort", check);
          resolve(built);
        }
      };
      t.wait.add(check);
      signal?.addEventListener("abort", check);
      check();
    });
  }

  export function span(part: Part): [number, number] {
    const a = part.i * 2 ** part.l;
    return [a, a + 2 ** part.l - 1];
  }

  export function flat(text: string): string {
    if (!text.includes("\n")) {
      return text;
    }
    return text.replace(/\s*\n\s*/g, " ");
  }

  // its zoom target, "id+n"
  export function ref(part: Part): string {
    return part.i * 2 ** part.l + "+" + 2 ** part.l;
  }

  export function line(part: Part, text: string): string {
    return Tree.ref(part) + "|" + Tree.flat(text);
  }

  export function before(view: Part[], end: number): Part[] {
    return view.filter((part) => Tree.span(part)[1] < end);
  }

  // the view's lines built before message `end`, in blocks (the last cut
  // short), one marked: the last whole one, else the opening one
  export function view(t: Tree, end = t.count, parts = t.view.parts): Block[] {
    const lines = Tree.before(parts, end).filter((part) => Tree.built(t, part.l, part.i)).map((part) => Tree.line(part, Tree.text(t, part)) + "\n");
    const whole = Math.floor(lines.length / BLOCK);
    const blocks: Block[] = [{ text: "<chat>\n", mark: whole === 0 }];
    for (let k = 0; k < whole; k++) {
      blocks.push({ text: lines.slice(k * BLOCK, (k + 1) * BLOCK).join(""), mark: k === whole - 1 });
    }
    blocks.push({ text: lines.slice(whole * BLOCK).join("") + "</chat>\n", mark: false });
    return blocks;
  }

  // the chat's view as one text, to message `end`, each line not built yet
  // shown as WAIT (a compaction that could not wait for the summaries)
  export function show_view(t: Tree, end = t.count): string {
    const lines = Tree.before(t.view.parts, end).map((part) => Tree.line(part, Tree.text(t, part)) + "\n");
    return "<chat>\n" + lines.join("") + "</chat>\n";
  }

  export function part(t: Tree, id: number, n: number): Part | null {
    const l = Math.log2(n);
    const ok = Number.isInteger(id) && Number.isInteger(l) && id >= 0 && id % n === 0 && id + n <= t.count;
    return ok ? { l, i: id / n } : null;
  }

  // a message (n = 1) whole, a long one a page from `at`; else the two
  // lines under id+n
  export async function zoom(t: Tree, id: number, n: number, at: number): Promise<string> {
    const part = Tree.part(t, id, n);
    const root = n === 1 ? await Tree.message(t, id) : null;
    if (part === null) {
      const roots = Tree.roots(t.count).map((root) => Tree.ref(root)).join(", ");
      return "No line " + id + "+" + n + ": n is a power of 2, id a multiple of n. The tree's roots: " + roots + ".";
    }
    if (root !== null) {
      return id + "+0|" + Tree.show({ ...root, text: Tree.clip_page(root.text, at) });
    }
    return Tree.halves(part).map((half) => Tree.line(half, Tree.text(t, half))).join("\n");
  }

  export async function date(t: Tree, id: number): Promise<string> {
    const root = await Tree.message(t, id);
    return root === null ? "No message " + id + "." : new Date(root.date).toLocaleString("sv-SE");
  }

  // no node starts again; calls waiting give up
  export function stop(t: Tree): void {
    t.done = true;
    t.wait.forEach((check) => check());
  }

}
