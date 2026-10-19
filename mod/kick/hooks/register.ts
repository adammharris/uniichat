// UniiChat's kick
// ===============
// Compacts the conversation whenever uniichat marks it due (uniichat.due,
// set as a turn ends with every summary built). It is its own plugin since
// a `$.session.compact()` runs through every hook but the calling
// plugin's: asked by uniichat, uniichat's session.compact would be
// skipped and Claude Code's own summary would take its place; asked from
// here, uniichat's hook answers with the view.

import type { Register } from "claude-code";

// a compaction's tries (it rejects while a turn runs), and the wait before each
const TRIES = 5;
const NAP   = 1e3;

export const register: Register = (on) => {
  // why compacting can't work in this session (headless: -p, the SDK), said once
  let cannot: string | null = null;
  let compacting: Promise<void> | null = null;

  on("state.set", async ($, e, next) => {
    const out = await next(e);
    if (e.plugin !== "uniichat" || e.key !== "due" || out.value?.isSet !== true || cannot !== null || compacting !== null) {
      return out;
    }
    compacting = (async () => {
      let why = "";
      for (let k = 0; k < TRIES; k++) {
        await new Promise<void>((ok) => void $.clock.after(NAP * k, ok));
        const done = await $.session.compact().then(() => true, (err) => ((why = String(err?.message ?? err)), false));
        if (done) {
          return;
        }
        if (/headless/.test(why)) {
          cannot = why;
          $.ui.log(why + " (only /compact compacts to the view here)");
          return;
        }
      }
      $.ui.log("could not compact after the turn (" + why + "); the next turn tries again");
    })().finally(() => (compacting = null));
    return out;
  });
};
