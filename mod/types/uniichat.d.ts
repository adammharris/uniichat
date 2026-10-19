// The values uniichat keeps in the session: `due`, the tree's count once
// a turn's summaries are built and the conversation should be compacted
// to the view (the kick plugin compacts on it).

export type UniichatDue = number;

declare module "claude-code" {
  interface PluginState {
    uniichat: { due: UniichatDue };
  }
}
