// UniiChat for Claude Code
// ========================
// The mod's hooks: every row of the main conversation is logged to the
// tree (Tree.ts) as UniiChat logs a chat's messages, and summarized in the
// background on the compactor; a compaction leaves the conversation as the
// tree's view, so each turn sees the whole chat as UniiChat's turns do.
//
// When: after a turn whose rows since the last compaction pass `threshold`
// bytes (0: after every turn, as UniiChat), once the summaries of every
// message are built (Tree.settle); and whenever Claude Code compacts on its
// own (its threshold, /compact), with the summaries as they are. A new
// conversation (a new session, /clear) gets the view in its first message.
//
// The memory is one chat, in `dir`, for one session at a time: a session
// that finds another's lock fresh leaves the memory alone.

import type { Register } from "claude-code";

import { COMPACTOR, MEMORY, compacted } from "./Prompt.ts";
import { Tree, type Io, type Kind, type Msg } from "./Tree.ts";

// Constants
// =========

const NAME = "uniichat";

// how often a session marks its lock, and how long one unmarked is stale
const BEAT  = 20e3;
const STALE = 60e3;

// a compaction asked as a turn ends: tries, and the wait before each
const TRIES = 5;
const NAP   = 1e3;

// Hooks
// =====

export const register: Register = (on, options) => {
  const threshold = Number(options.threshold ?? 0);
  const compactor = String(options.compactor || "haiku");
  const effort = String(options.effort || "high") as "low" | "medium" | "high" | "xhigh" | "max";
  let tree: Tree | null = null;
  let me = "";
  // bytes logged since the conversation was last compacted
  let since = 0;
  // whether this conversation holds a view (its first message's, or a
  // compaction's): a new one gets it as context
  let viewed = false;
  let compacting: Promise<void> | null = null;
  // why a plugin can't compact in this session (headless: -p, the SDK),
  // said once; then only Claude Code's own compactions (/compact) do
  let cannot: string | null = null;

  on("session.start", async ($, e, next) => {
    const out = await next(e);
    const home = (await $.env.get("HOME")) ?? "";
    const dir = String(options.dir || home + "/.uniichat");
    me = await $.session.id();
    const lock = Tree.parse((await $.fs.exists(dir + "/lock.json")) ? await $.fs.read(dir + "/lock.json") : null);
    if (lock?.id && lock.id !== me && Date.now() - Number(lock.at) < STALE) {
      $.ui.status(NAME + ": off (another session holds " + dir + ")");
      return out;
    }
    const mark = () => $.fs.write(dir + "/lock.json", JSON.stringify({ id: me, at: Date.now() }));
    await mark();
    $.clock.every(BEAT, () => void mark());
    const io: Io = {
      read  : async (path) => ((await $.fs.exists(dir + "/" + path)) ? String(await $.fs.read(dir + "/" + path)) : null),
      write : (path, text) => $.fs.write(dir + "/" + path, text),
      ask   : async (blocks) => {
        const prompt = blocks.map((b) => (b.mark ? { text: b.text, cache: true as const } : { text: b.text }));
        const r = await $.model.complete({ model: compactor, effort, maxTokens: 8000, system: [{ text: COMPACTOR, cache: true }], prompt });
        if (r.isAnswered) {
          return { ok: true, text: r.text };
        }
        const status = r.reason === "api-error" ? r.status : null;
        const refused = r.reason === "empty-reply" || status === 400;
        return { ok: false, refused, text: r.reason + (status === null ? "" : " " + status) };
      },
      now   : () => Date.now(),
      sleep : (ms) => new Promise((ok) => void $.clock.after(ms, ok)),
      error : (text) => $.ui.log(NAME + ": " + text),
    };
    tree = await Tree.load(io);
    const t = tree;
    let shown = "";
    t.made = () => {
      const text = NAME + ": " + t.count + " messages" + (t.busy.size > 0 ? ", summarizing " + t.busy.size : "");
      if (text !== shown) {
        $.ui.status((shown = text));
      }
    };
    t.made();
    await $.tool.register({
      name: "zoom",
      description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. A long text comes in pages from character at, saying where to go on.",
      inputSchema: { type: "object", properties: { id: { type: "integer" }, n: { type: "integer" }, at: { type: "integer" } }, required: ["id"] },
      isDeferred: false,
    });
    await $.tool.register({
      name: "date",
      description: "The date and time of message id.",
      inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      isDeferred: false,
    });
    return out;
  });

  on("session.end", async ($, e, next) => {
    if (tree !== null && e.reason === "clear") {
      viewed = false;
      since = 0;
      return next(e);
    }
    if (tree !== null) {
      Tree.stop(tree);
      await tree.writes;
      await $.fs.write(String(options.dir || ((await $.env.get("HOME")) ?? "") + "/.uniichat") + "/lock.json", JSON.stringify({ id: null, at: 0 }));
    }
    return next(e);
  });

  on("prompt.compose", async ($, e, next) => {
    const out = await next(e);
    if (tree === null) {
      return out;
    }
    return { sections: [...out.sections, { id: NAME + ":memory", text: MEMORY, scope: "session" as const }] };
  });

  // a conversation's first message: the view, unless a compaction left one
  on("prompt.context", async ($, e, next) => {
    const out = await next(e);
    if (tree === null || viewed || tree.count === 0) {
      return out;
    }
    viewed = true;
    return { ...out, blocks: [...out.blocks, { name: NAME, text: compacted(Tree.show_view(tree), tree.count) }] };
  });

  // every row of the main conversation, as UniiChat logs its messages
  on("session.append", async ($, e, next) => {
    const out = await next(e);
    if (tree !== null && e.agentId === undefined && !("deny" in out && out.deny)) {
      const msgs = rows(e.door, e.message);
      if (msgs.length > 0) {
        Tree.push(tree, msgs);
        since += msgs.reduce((n, msg) => n + Tree.bytes(msg.text), 0);
      }
    }
    return out;
  }).catch(($, e, next) => next(e));

  on("turn.complete", async ($, e, next) => {
    const out = await next(e);
    if (tree === null || e.agentId !== undefined || compacting !== null || cannot !== null || since === 0 || since < threshold) {
      return out;
    }
    const t = tree;
    compacting = (async () => {
      await Tree.settle(t, t.count);
      let why = "";
      for (let k = 0; k < TRIES && since > 0; k++) {
        await new Promise<void>((ok) => void $.clock.after(NAP * k, ok));
        const done = await $.session.compact().then(() => true, (err) => ((why = String(err?.message ?? err)), false));
        if (done) {
          return;
        }
        if (/headless/.test(why)) {
          cannot = why;
          $.ui.log(NAME + ": " + why + " (only /compact compacts to the view here)");
          return;
        }
      }
      $.ui.log(NAME + ": could not compact after the turn (" + why + "); the next turn tries again");
    })().finally(() => (compacting = null));
    return out;
  });

  // the conversation as the view: the summaries as they are (built, after
  // a turn: turn.complete waited for them)
  on("session.compact", async ($, e, next) => {
    if (tree === null || e.agentId !== undefined) {
      return next(e);
    }
    if (e.trigger === "precompute") {
      return { skip: NAME + " compacts to its own view" };
    }
    since = 0;
    viewed = true;
    return { messages: [{ role: "user" as const, text: compacted(Tree.show_view(tree), tree.count), toolUses: [] }] };
  }).catch(($, e, next) => next(e));

  on("tool.call", { tool: "mcp__uniichat__zoom" }, async ($, e) => {
    const args = e as unknown as { id: unknown; n?: unknown; at?: unknown };
    if (tree === null) {
      return { result: "The memory is off in this session." };
    }
    return { result: await Tree.zoom(tree, Number(args.id), Number(args.n ?? 1), Number(args.at ?? 0)) };
  });

  on("tool.call", { tool: "mcp__uniichat__date" }, async ($, e) => {
    const args = e as unknown as { id: unknown };
    if (tree === null) {
      return { result: "The memory is off in this session." };
    }
    return { result: await Tree.date(tree, Number(args.id)) };
  });
};

// Rows
// ====

type Block = { type: string; [field: string]: unknown };

// a row of the conversation as messages: the user's prompt, the agent's
// replies and tool calls, their results, a background task's report;
// nothing else (the engine's reminders, notices, commands, compactions)
export function rows(door: string, message: { content: Block[]; isMeta?: true }): Msg[] {
  const blocks = message.content ?? [];
  const text = blocks.map(show).filter((s) => s !== "").join("\n");
  const one = (kind: Kind, text: string): Msg[] => (text.trim() === "" ? [] : [{ kind, text }]);
  switch (door) {
    case "prompt": {
      return message.isMeta ? [] : one("user", text);
    }
    case "delivery": {
      return one(message.isMeta ? "work" : "user", text);
    }
    case "response": {
      return blocks.flatMap((b) => (b.type === "text" ? one("agent", String(b.text)) : b.type === "tool_use" ? one("tool", b.name + " " + JSON.stringify(b.input)) : []));
    }
    case "tool-result": {
      return blocks.flatMap((b) => (b.type === "tool_result" ? one("echo", (b.is_error ? "error: " : "") + content(b.content)) : []));
    }
    default: {
      return [];
    }
  }
}

// a block of a prompt as text: its text, or what it is
function show(b: Block): string {
  return b.type === "text" ? String(b.text) : "[" + b.type + "]";
}

// a tool result's content (a string, or blocks) as text
function content(c: unknown): string {
  if (typeof c === "string") {
    return c;
  }
  return Array.isArray(c) ? c.map((b: Block) => show(b)).join("\n") : "";
}
