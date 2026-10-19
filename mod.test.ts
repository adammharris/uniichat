// Mod test
// ========
// `bun test mod.test.ts`. The mod's Tree (mod/hooks/Tree.ts) against
// Memory.ts: the same merges, views, tasks and build order on the same
// trees; then a chat replayed through the Tree alone against a fake
// compactor that caches by Anthropic's rules (cache.test.ts's), as fast
// as summaries really come; then a reload from its files.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

import { HIGH, SEEN, Tree, type Block, type Io, type Msg, type Part } from "./mod/hooks/Tree.ts";
import { rows } from "./mod/hooks/register.ts";

process.env.UNII_DIR = fs.mkdtempSync(os.tmpdir() + "/unii-mod-");
const { Memory } = await import("./Memory.ts");

// Random
// ======

let seed = 7;

function rand(): number {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
}

function rand_span(a: number, b: number): number {
  return a * (b / a) ** rand();
}

function words(n: number): string {
  return Array.from({ length: Math.max(1, Math.round(n / 6)) }, () => Math.floor(rand() * 1e6).toString(36)).join(" ");
}

// a tree of `count` messages, every node built with a line of its own
// length, as Memory and as Tree hold it (they share the map)
function built(count: number): Map<number, string> {
  const nodes = new Map<number, string>();
  for (let l = 0; 2 ** l <= count; l++) {
    for (let i = 0; (i + 1) * 2 ** l <= count; i++) {
      nodes.set(Tree.slot(l, i), words(l === 0 ? rand_span(20, 600) : rand_span(200, 512)));
    }
  }
  return nodes;
}

function tree_of(nodes: Map<number, string>, count: number): Tree {
  return { nodes, count } as unknown as Tree;
}

// Same as Memory.ts
// =================

test("a view merges as Memory.ts's: the same lines, oldest first, by due", () => {
  for (let run = 0; run < 40; run++) {
    const count = Math.floor(rand_span(50, 4000));
    const nodes = built(count);
    // some parents not built yet, as when summaries lag
    for (const key of [...nodes.keys()]) {
      if (key % 2 === 1 && rand() < 0.1) {
        nodes.delete(key);
      }
    }
    const t = tree_of(nodes, count);
    const mem = { nodes } as any;
    const parts: Part[] = Array.from({ length: count }, (_, i) => ({ l: 0, i }));
    const high = [HIGH, SEEN, 4000][run % 3]!;
    const size = parts.reduce((n, part) => n + Tree.size(t, part), 0);
    const view = { parts, size, batch: false, high };
    const ours = Tree.merge(t, view);
    const theirs = Memory.merge(mem, { ...view, parts: [...parts] });
    expect(ours.parts).toEqual(theirs.parts);
    expect(ours.size).toBe(theirs.size);
  }
});

test("a call's view blocks, marks, tasks and refs are Memory.ts's", () => {
  const count = 777;
  const nodes = built(count);
  const t = tree_of(nodes, count);
  const mem = { nodes, count } as any;
  const parts = Tree.roots(count).flatMap((part) => Tree.down(t, part, null));
  expect(parts).toEqual(Memory.roots(count).flatMap((part: Part) => Memory.down(mem, part, null)));
  for (const end of [0, 3, 100, 512, 777]) {
    expect(Tree.view(t, end, parts)).toEqual(Memory.view(mem, end, parts));
  }
  for (const [l, i] of [[0, 0], [0, 776], [1, 5], [4, 3], [9, 0]] as const) {
    expect(Tree.task(l, i)).toBe(Memory.task(l, i));
    expect(Tree.ctx(l, i)).toBe(Memory.ctx(l, i));
  }
  expect(Tree.over("é".repeat(400))).toBe(Memory.over("é".repeat(400)));
  expect(Tree.cut("é".repeat(400))).toBe(Memory.cut("é".repeat(400)));
});

// both views of a chat, kept as Memory.ts keeps them and as Tree keeps
// them, step by step: messages come, some nodes ready build (the same in
// both), each fits. Neither calls a model: both are stopped, and nodes are stored by hand
test("the views fit as Memory.ts's, step by step, batches and the compactions' view too", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-mod-fit-");
  const mem = Memory.load(dir, () => ({}) as any);
  mem.done = true;
  const files = new Map<string, string>();
  const t = await Tree.load({ read: async (p) => files.get(p) ?? null, write: async (p, s) => void files.set(p, s), ask: () => new Promise(() => {}), now: () => 0, sleep: () => new Promise(() => {}), error: () => {} });
  t.done = true;
  // small views, so batches come often
  for (const [view, high] of [[mem.view, 6000], [mem.seen, 2000], [t.view, 6000], [t.seen, 2000]] as const) {
    view.high = high;
  }
  for (let step = 0; step < 3000; step++) {
    if (rand() < 0.6) {
      const msg: Msg = { kind: "user", text: words(rand_span(20, 900)) };
      Memory.push(mem, [msg]);
      Tree.push(t, [msg]);
    }
    // a few ready nodes build, oldest first, as summaries come back
    const ready = t.ready.flatMap((queue, l) => queue.map((i) => ({ l, i }))).sort((a, b) => Tree.ctx(a.l, a.i) - Tree.ctx(b.l, b.i));
    const theirs = mem.ready[0].flatMap((queue: number[], l: number) => (queue ?? []).map((i) => ({ l, i }))).sort((a: Part, b: Part) => Memory.ctx(a.l, a.i) - Memory.ctx(b.l, b.i));
    expect(ready).toEqual(theirs);
    const done = ready.slice(0, Math.floor(rand() * 4)).map((part) => ({ ...part, text: words(rand_span(30, 500)) }));
    if (done.length > 0) {
      Memory.store(mem, done);
      Tree.store(t, done);
      Memory.fit(mem);
      Tree.fit(t);
    }
    // now and then, what would start: the same nodes, jobs and free, in
    // the same order (each `job` recorded, not run)
    if (step % 50 === 0) {
      const [job, tjob] = [Memory.job, Tree.job];
      const jobs: { ours: string[]; theirs: string[] } = { ours: [], theirs: [] };
      Memory.job = (_: any, l: number, i: number) => void jobs.theirs.push(l + "/" + i);
      Tree.job = (_: any, l: number, i: number) => void jobs.ours.push(l + "/" + i);
      // the Tree's own pump kept out meanwhile
      await new Promise((ok) => setImmediate(ok));
      t.pumping = true;
      [mem.done, t.done] = [false, false];
      const free = Memory.starts(mem).map((p: Part) => p.l + "/" + p.i);
      const tfree = (await Tree.starts(t)).map((p) => p.l + "/" + p.i);
      [mem.done, t.done, t.pumping] = [true, true, false];
      [Memory.job, Tree.job] = [job, tjob];
      expect(tfree).toEqual(free);
      expect(jobs.ours).toEqual(jobs.theirs);
      // the first job's call: the same blocks asked, its line stored in both
      const first = jobs.ours[0]?.split("/").map(Number);
      if (first !== undefined) {
        const [l, i] = first as [number, number];
        const [ask, task] = [Memory.ask, Tree.ask];
        const asked: { ours: Block[][]; theirs: Block[][] } = { ours: [], theirs: [] };
        const line = words(300);
        Memory.ask = (_: any, _l: number, _i: number, _text: string, blocks: Block[]) => {
          asked.theirs.push(blocks);
          return { done: Promise.resolve({ ok: true, text: line, left: [] }), send: () => {}, stop: () => {}, move: () => {} };
        };
        Tree.ask = async (_: Tree, blocks: Block[]) => (asked.ours.push(blocks), { ok: true, text: line });
        await Memory.build(mem, l, i, Memory.source(mem, l, i)!, null);
        await Tree.build(t, l, i, (await Tree.source(t, l, i))!);
        [Memory.ask, Tree.ask] = [ask, task];
        expect(asked.ours).toEqual(asked.theirs);
        Memory.fit(mem);
        Tree.fit(t);
      }
    }
    expect(t.view.parts).toEqual(mem.view.parts);
    expect(t.view.batch).toBe(mem.view.batch);
    expect(t.seen.parts).toEqual(mem.seen.parts);
    expect(t.seen.batch).toBe(mem.seen.batch);
  }
  // the batches did come
  expect(t.view.parts.some((part) => part.l > 0)).toBe(true);
  expect(t.seen.parts.some((part) => part.l > 0)).toBe(true);
});

// a burst (a hundred messages at once, a fresh tree): their compactions
// share one prefix, so one writes it and the rest wait to read it
test("single flight: of calls sharing a prefix, one writes it, the rest read it", async () => {
  const files = new Map<string, string>();
  const use: Use = { read: 0, write: 0, input: 0, n: 0 };
  const t = await Tree.load(fake(files, use, new Map()));
  Tree.push(t, Array.from({ length: 100 }, (_, k): Msg => ({ kind: "echo", text: "echo " + k + " " + words(3000) })));
  await drain();
  expect(Tree.first(t)).toBe(t.count);
  // the system prompt and the view's opening written by the first call
  // alone: the other 63 of its wave waited for it, then read them
  expect(use.cold).toBe(1);
  Tree.stop(t);
});

// Replay
// ======

// a fake clock: events at times, run in order
let now = Date.UTC(2026, 9, 1);
const queue: Array<{ at: number; go: () => void }> = [];

function later(ms: number, go: () => void): void {
  const at = now + ms;
  const k = queue.findIndex((ev) => ev.at > at);
  queue.splice(k < 0 ? queue.length : k, 0, { at, go });
}

async function drain(): Promise<void> {
  for (let idle = 0; idle < 4; idle = queue.length > 0 ? 0 : idle + 1) {
    while (queue.length > 0) {
      const ev = queue.shift()!;
      now = Math.max(now, ev.at);
      ev.go();
      for (let k = 0; k < 8; k++) {
        await new Promise((ok) => setImmediate(ok));
      }
    }
    await new Promise((ok) => setImmediate(ok));
  }
}

// Anthropic's cache, as cache.test.ts fakes it: an entry written only at a
// breakpoint, keyed by the prefix up to it, read walking back at most LOOK
// blocks from each breakpoint, serving once its writer's response began
// (FIRST after it is sent), living TTL past its last use
const LOOK  = 20;
const TTL   = 300e3;
const FIRST = 1500;

// cold: calls that read nothing from the cache
type Use = { read: number; write: number; input: number; n: number; cold?: number };

function cache_use(cache: Map<string, { from: number; until: number }>, blocks: Block[]): Use {
  expect(blocks.filter((b) => b.mark).length).toBeLessThanOrEqual(3);
  const marks = blocks.flatMap((b, k) => (b.mark ? [k] : []));
  const keys: string[] = [];
  const ends: number[] = [];
  for (const b of blocks) {
    keys.push(Tree.hash((keys[keys.length - 1] ?? "") + "\u0000" + b.text));
    ends.push((ends[ends.length - 1] ?? 0) + b.text.length);
  }
  const live = (k: number) => (cache.get(keys[k]!)?.from ?? Infinity) <= now && cache.get(keys[k]!)!.until >= now;
  let hit = -1;
  for (const m of marks) {
    for (let k = m; k > m - LOOK && k >= 0; k--) {
      if (live(k)) {
        hit = Math.max(hit, k);
        break;
      }
    }
  }
  if (hit >= 0) {
    cache.get(keys[hit]!)!.until = now + TTL;
  }
  for (const m of marks.filter((m) => m > hit && !(cache.get(keys[m]!)?.until! >= now))) {
    cache.set(keys[m]!, { from: now + FIRST, until: now + TTL });
  }
  const read = hit < 0 ? 0 : ends[hit]!;
  const write = Math.max(0, (ends[Math.max(-1, ...marks)] ?? 0) - read);
  return { read, write, input: ends[ends.length - 1]! - read - write, n: 1 };
}

// a node a task asks for
function task_node(task: string): [number, number] {
  const leaf = /compress message (\d+)/.exec(task);
  const pair = /merge lines (\d+)\+(\d+)/.exec(task)!;
  return leaf ? [0, Number(leaf[1])] : [Math.log2(Number(pair[2])) + 1, Number(pair[1]) / Number(pair[2]) / 2];
}

// files in memory, and a compactor answering in seconds: a line as long
// as real ones vary, a fourth too long at first
function fake(files: Map<string, string>, use: Use, asked: Map<string, number>): Io {
  const cache = new Map<string, { from: number; until: number }>();
  const system: Block = { text: "system ".repeat(2000), mark: true };
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, text) => void files.set(path, text),
    now: () => now,
    sleep: (ms) => new Promise((ok) => later(ms, () => ok())),
    error: (text) => {
      throw new Error(text);
    },
    ask: (blocks) => {
      const u = cache_use(cache, [system, ...blocks]);
      const task = blocks.findLast((b) => b.text.startsWith("Compaction:"))!.text;
      const again = blocks[blocks.length - 1]!.text.startsWith("Too long:");
      const node = task_node(task);
      asked.set(node.join(), (asked.get(node.join()) ?? 0) + 1);
      for (const k of ["read", "write", "input", "n"] as const) {
        use[k] += u[k];
      }
      use.input -= task.length;
      use.cold = (use.cold ?? 0) + (u.read === 0 ? 1 : 0);
      const long = !again && node[1] % 4 === 0 ? 400 : 0;
      const line = "line " + node[0] + "/" + node[1] + " " + "x".repeat(120 + long + ((node[1] * 7919 + node[0]) % 330));
      return new Promise((ok) => later(rand_span(3000, 9000), () => ok({ ok: true, text: line })));
    },
  };
}

// a chat of `n` messages: turns of tool steps, at a human's pace
function synthetic(n: number): Array<Msg & { at: number }> {
  const logs: Array<Msg & { at: number }> = [];
  let at = 0;
  const say = (kind: Msg["kind"], a: number, b: number, gap: number) => {
    at += gap;
    logs.push({ kind, text: kind + " " + words(rand_span(a, b)), at });
  };
  while (logs.length < n) {
    const steps = Math.floor(rand() * 7);
    say("user", 40, 1500, rand_span(20e3, 240e3));
    for (let k = 0; k < steps; k++) {
      say("tool", 80, 600, rand_span(2e3, 12e3));
      say("echo", 40, 8000, rand_span(1e3, 6e3));
    }
    say("agent", 100, 2500, rand_span(2e3, 9e3));
  }
  return logs;
}

test("a long chat: compactions read >= 95% from the cache, each node asked once, the view decays", async () => {
  const files = new Map<string, string>();
  const use: Use = { read: 0, write: 0, input: 0, n: 0 };
  const asked = new Map<string, number>();
  const t = await Tree.load(fake(files, use, asked));
  const logs = synthetic(3000);
  for (const log of logs) {
    later(log.at, () => void Tree.push(t, [{ kind: log.kind, text: log.text }]));
  }
  await drain();
  await t.writes;
  const share = use.read / (use.read + use.write + use.input);
  console.log("compactions: " + use.n + " requests, " + (100 * share).toFixed(1) + "% read");
  expect(share).toBeGreaterThanOrEqual(0.95);
  // every node built, none asked but its tries (a line too long: twice)
  expect(Tree.first(t)).toBe(t.count);
  for (const [node, n] of asked) {
    expect(n).toBeLessThanOrEqual(Number(node.split(",")[1]) % 4 === 0 ? 2 : 1);
  }
  // the view covers the chat, in order, within its bounds
  let next = 0;
  for (const part of t.view.parts) {
    expect(Tree.span(part)[0]).toBe(next);
    next = Tree.span(part)[1] + 1;
  }
  expect(next).toBe(t.count);
  expect(t.view.size).toBeLessThanOrEqual(HIGH);
  // detail fades with age: the older the quarter, the more a line covers
  const quarters = [0, 1, 2, 3].map((q) => t.view.parts.filter((part) => Tree.span(part)[0] * 4 >= q * t.count && Tree.span(part)[0] * 4 < (q + 1) * t.count));
  const cover = quarters.map((parts) => parts.reduce((n, part) => n + 2 ** part.l, 0) / parts.length);
  expect(cover[0]!).toBeGreaterThan(cover[1]!);
  expect(cover[1]!).toBeGreaterThan(cover[2]!);
  expect(cover[2]!).toBeGreaterThan(cover[3]!);

  // a reload from the files: the same chat, view and nodes
  const again = await Tree.load(fake(files, use, asked));
  expect(again.count).toBe(t.count);
  expect(again.view.parts).toEqual(t.view.parts);
  expect(again.nodes).toEqual(t.nodes);
  expect(await Tree.zoom(again, 5, 1, 0)).toBe(await Tree.zoom(t, 5, 1, 0));
  expect((await Tree.zoom(again, 5, 1, 0)).startsWith("5+0|" + logs[5]!.kind + ": ")).toBe(true);
  expect(await Tree.zoom(again, 0, 8, 0)).toBe(await Tree.zoom(t, 0, 8, 0));
  Tree.stop(t);
  Tree.stop(again);
}, 600e3);

// Rows
// ====

test("rows: prompts, replies, tool calls and results are logged; the rest is not", () => {
  expect(rows("prompt", { content: [{ type: "text", text: "hi" }] })).toEqual([{ kind: "user", text: "hi" }]);
  expect(rows("prompt", { content: [{ type: "text", text: "hidden" }], isMeta: true })).toEqual([]);
  expect(rows("response", { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "ok" }, { type: "tool_use", name: "Read", input: { file_path: "a" } }] })).toEqual([
    { kind: "agent", text: "ok" },
    { kind: "tool", text: 'Read {"file_path":"a"}' },
  ]);
  expect(rows("tool-result", { content: [{ type: "tool_result", tool_use_id: "1", content: [{ type: "text", text: "out" }], is_error: true }] })).toEqual([{ kind: "echo", text: "error: out" }]);
  expect(rows("compaction", { content: [{ type: "text", text: "<chat>" }] })).toEqual([]);
  expect(rows("attachment", { content: [{ type: "text", text: "reminder" }] })).toEqual([]);
});

test("a long message goes in pages of CAP characters", () => {
  const text = "a".repeat(70000);
  expect(Tree.pages({ kind: "echo", text }).map((m) => m.text.length)).toEqual([30000, 30000, 10000]);
});
