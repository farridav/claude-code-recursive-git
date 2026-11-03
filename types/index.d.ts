/** The state of one working tree: a repo's main checkout or a linked worktree. */
export type TreeStatus = {
  path: string
  /** Null when HEAD is detached. */
  branch: string | null
  /** Short commit id, or null in a repo with no commits yet. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  /** Short status lines (`M  src/app.py`), capped. */
  files: string[]
  /** Set when git worktree list marks the worktree prunable (its folder is gone). */
  isPrunable: boolean
  /** Set when git could not read the tree. */
  error: string | null
}

export type RepoStatus = {
  /** The repo's path relative to the workspace root. */
  name: string
  path: string
  /** The default branch, from origin/HEAD, else main or master; null when unknown. */
  defaultBranch: string | null
  /** The last few commits of the main checkout, `abc1234 subject`. */
  recent: string[]
  tree: TreeStatus
  /** Linked worktrees, wherever they are on disk. */
  worktrees: TreeStatus[]
}

declare module 'claude-code' {
  interface PluginState {
    'multi-repo': {
      repos: Shaped<RepoStatus[]>
      /** The folder the session started in; fixed for the session. */
      workspaceRoot: string | null
      /** What the model was last told, per tree path: a fingerprint of its state. */
      reported: Record<string, string> | null
      /** The folders folded shut in the /repos pane, by path under the root. */
      folded: string[]
    }
  }
}
