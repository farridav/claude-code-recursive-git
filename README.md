# multi-repo

A Claude Code mod for people who start Claude Code in a folder that **holds** many git repos, rather than inside one repo, and work across them in parallel.

On its own, Claude Code treats such a folder as "not a git repository". It shows no branch, gives Claude no git status, and leaves Claude to work out the layout itself. This mod finds every repo under the folder and gives each one the git awareness a single-repo session has.

## What you get

| In a single repo, Claude Code has… | With this mod, in a multi-repo folder |
| --- | --- |
| A `gitStatus` snapshot in Claude's context (branch, main branch, status, recent commits) | A `multiRepoStatus` snapshot covering **every** repo and its worktrees |
| The status refreshed as you work | Each prompt carries the repos that **changed** since Claude last saw them, and only those |
| Git commands that just work | System-prompt guidance: `git -C <repo>`, one commit/PR per repo, parallel work across repos, one worktree per parallel task in the same repo |
| The branch in the UI | A status line (`⎇ 12 repos · 2 worktrees · 3 dirty · 1 ahead`, plus the repo you are in), and a band above the prompt with the repos that need attention (`api main* ↑2 +1wt`) |
| — | `/repos`: a pane with every repo and worktree, plus Refresh and Fetch all buttons |
| — | `/repos-fetch`: `git fetch --all --prune` in every repo, in parallel |
| — | A `repo_status` tool Claude calls for fresh status of one repo or all of them |

Status refreshes after each Bash, Edit, Write, EnterWorktree and ExitWorktree call, every 60 seconds, and before a prompt when the last scan is more than 10 seconds old.

## Worktrees

- Linked worktrees are listed under their repo, wherever they live on disk: next to the repo, in `.claude/worktrees/`, or anywhere else. They come from `git worktree list`, so each one appears once. Worktrees whose folder has gone are marked prunable.
- A folder whose `.git` is a file pointing at `<repo>/.git/worktrees/…` is folded into its main repo. A submodule (its `.git` points into `.git/modules/…`) belongs to its parent repo and is not listed on its own.
- The folder you started in stays the workspace root after `EnterWorktree` moves the session. The status line shows which repo or worktree you are in.

## Which repos are found

- Folders up to **4 levels** below the session's starting folder (`scanDepth` changes this).
- The scan never looks inside a repo it has found. Dependency checkouts inside your repos (`node_modules`, `.terraform`, vendored Ansible roles, packages that ship a whole git repo) are never picked up.
- Between the root and your repos it skips hidden folders (`.terraform`, `.venv`, `.ansible`, `.cache`, …) and `node_modules, vendor, venv, site-packages, bower_components, Pods, target, dist, build, galaxy_roles, collections`. The `ignore` setting adds more names.
- If the starting folder is itself a repo, the mod does nothing: Claude Code's own git support already covers it.

## Settings

Set these in `/config`, or under `pluginConfigs.multi-repo` in settings:

| Setting | Default | |
| --- | --- | --- |
| `scanDepth` | `4` | How many folder levels below the root to search |
| `ignore` | `""` | Extra folder names to skip, comma-separated |
| `showBand` | `true` | Show the band of repos with changes above the prompt |

## Install

At the prompt of a Claude Code session:

```
/plugin install multi-repo --marketplace farridav/claude-code-recursive-git
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install multi-repo --marketplace farridav/claude-code-recursive-git
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `farridav/claude-code-recursive-git`, then Add plugin.

## Developing

```
claude --plugin-dir /path/to/claude-code-recursive-git   # run it from a checkout
claude plugin validate .
claude plugin test .
```

`hooks/git.ts` holds discovery, git parsing and the text Claude reads, as plain functions. `hooks/register.tsx` wires them to Claude Code's hooks.
