UniiChat for Claude Code
========================

A Claude Code mod that gives Claude Code UniiChat's memory: one chat that
never ends, kept as a binary tree of summaries, with each conversation
compacted to a view of that tree that the model can `zoom` into.

**A prototype.** It runs and its tests pass, but it has been tried
mostly in headless sessions. Expect rough edges.

How it works
------------

- **Every message is logged.** Each row of the main conversation (your
  prompt, Claude's replies, its tool calls and their results) is logged
  as a message, as UniiChat logs a chat. Text longer than 30,000
  characters is split into several messages.
- **The tree is built in the background.** Summaries are written on the
  compactor model through `$.model.complete`, so they use your Claude
  Code login. The algorithm is UniiChat's, ported from `Memory.ts`: the
  order nodes are built in, a line that is too long being asked for
  again, the views merging the most overdue pairs in batches so that
  detail fades with age, the cache marks on the last whole block of the
  view, and single flight for calls that share a prefix.
- **A compaction leaves only the view.** After a turn, once every message
  has its summary, the mod compacts the conversation. Its
  `session.compact` hook returns the view in place of Claude Code's own
  summary. With `threshold` at 0 this happens after every turn, so each
  turn sees the whole chat as UniiChat's turns do; the default, 200000,
  waits for about 50k tokens of new messages. Claude
  Code's own compactions (`/compact`, or reaching its limit) also become
  the view.
- **A new conversation starts with the view.** A new session, or one after
  `/clear`, gets the view in its first message, so the chat goes on
  across sessions.
- **Zoom.** `mcp__uniichat__zoom(id, n)` opens a line into its two halves,
  down to a whole message, and `mcp__uniichat__date(id)` gives a
  message's date. A section added to the system prompt tells the model
  how to read the view and when to zoom.

Run it
------

    claude --plugin-dir /path/to/uniichat/mod --plugin-dir /path/to/uniichat/mod/kick

`kick/` is a second, tiny plugin that does the compaction when a turn
ends. A plugin's `$.session.compact()` runs every hook except the
calling plugin's own. If uniichat asked for the compaction itself, its
`session.compact` hook would be skipped, and Claude Code's own prose
summary would replace the view. So uniichat marks the conversation due
(`uniichat.due`) and kick makes the call. Without kick, only `/compact`
and Claude Code's auto-compaction compact to the view.

Options are set with `/config`, or under `pluginConfigs` in settings
(the key is `uniichat@inline` for a `--plugin-dir` mod):

- `threshold`: how many bytes of messages since the last compaction a
  turn's end needs before it compacts to the view (default 200000, about
  50k tokens; 0: after every turn, as UniiChat does).
- `compactor`: the model that writes the summaries (default `haiku`).
- `effort`: the compactor's effort (default `high`).
- `dir`: where the chat is kept (default `~/.uniichat`).

The chat lives in `dir`: `main/` (messages, 16 to a file), `tree/`
(summaries) and `state.json` (the views). Those files are the memory, so
back them up.

How it differs from UniiChat
----------------------------

- **No caching between turns.** A mod can't place cache marks on the main
  conversation, so with `threshold` at 0 each turn re-reads the view at
  full price. Steps within a turn are still cached. The summaries' own
  calls keep UniiChat's marks and single flight. A higher `threshold`
  trades fidelity for caching: recent turns stay in full text until the
  next compaction.
- **Headless sessions** (`claude -p`, the SDK) can't compact from a
  plugin yet, so there the view replaces the conversation only on
  `/compact`.
- **One session at a time.** A session that finds another's lock (less
  than a minute old) leaves the memory alone.
- **No imports, images, subagents of its own or devices.** Claude Code
  has its own tools and subagents; their results are logged like any
  other tool result.
- **Every built summary stays in memory.** That is fine for a prototype,
  but a chat years long will want UniiChat's index files.

Tests
-----

    bun test mod.test.ts

`mod.test.ts`, at the repository's root, checks the port against
`Memory.ts` itself. Over thousands of random steps it checks that both
produce the same merges, views, batches, compaction views, build order,
jobs and summary requests. It then replays a 3,000-message chat against a
fake compactor that caches by Anthropic's rules. Summary calls must read
at least 95% of their input from the cache, each node must be asked for
only once, single flight must hold, detail must fade with age, and the
chat must reload intact from its files.
