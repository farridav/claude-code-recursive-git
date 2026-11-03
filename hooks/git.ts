import type { FsEntry, ProcessRunInit, ProcessRunResult } from 'claude-code'

import type { RepoStatus, TreeStatus } from '../types'

/** Folders that hold other people's code, never the person's own repos. */
export const DEFAULT_IGNORE = [
  'node_modules',
  'vendor',
  'venv',
  'site-packages',
  'bower_components',
  'Pods',
  'target',
  'dist',
  'build',
  'galaxy_roles',
  'collections',
]

const MAX_FILES = 20
const RECENT_COMMITS = 5
const CONCURRENCY = 8

/** The file and process access the scan needs, handed in by the hooks module. */
export type Io = {
  list: (path: string) => Promise<FsEntry[]>
  readFile: (path: string) => Promise<string>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
}

// ---------------------------------------------------------------- paths

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** Resolves `target` against `base` and removes `.` and `..` segments. */
export function resolvePath(base: string, target: string): string {
  const full = target.startsWith('/') ? target : joinPath(base, target)
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

export function relativePath(from: string, to: string): string {
  const a = from.split('/').filter(Boolean)
  const b = to.split('/').filter(Boolean)
  let shared = 0
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++
  const up = a.slice(shared).map(() => '..')
  return [...up, ...b.slice(shared)].join('/') || '.'
}

/**
 * A worktree's folder name, less the `<repo>--` it is usually made with:
 * `on-demand-forecasting--odfe-skip` is shown as `odfe-skip`.
 */
export function worktreeName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const cut = name.indexOf('--')
  return cut > 0 && cut + 2 < name.length ? name.slice(cut + 2) : name
}

// ---------------------------------------------------------------- discovery

/**
 * What a `.git` file (not folder) means: a linked worktree, whose main repo
 * is returned, or a submodule, which belongs to its parent and is skipped.
 */
export function classifyGitFile(dir: string, text: string): { kind: 'worktree'; mainRepo: string } | { kind: 'skip' } {
  const match = /^gitdir:\s*(.+)$/m.exec(text)
  if (!match?.[1]) return { kind: 'skip' }
  const gitdir = resolvePath(dir, match[1].trim())
  const cut = gitdir.lastIndexOf('/worktrees/')
  if (cut < 0) return { kind: 'skip' } // a submodule: .git/modules/<name>
  const commonDir = gitdir.slice(0, cut)
  // A bare repo's worktree has no main checkout: list it under itself.
  const mainRepo = commonDir.endsWith('/.git') ? commonDir.slice(0, -'/.git'.length) : dir
  return { kind: 'worktree', mainRepo }
}

/**
 * Finds the git repos under `root`, at most `maxDepth` folders down. It never
 * looks inside a repo, nor into dot-folders, `_` folders or the `ignore` names,
 * so dependency checkouts (node_modules, .terraform, vendored roles) and
 * parked work (`_archive`) stay out.
 */
export async function findRepos(io: Io, root: string, maxDepth: number, ignore: ReadonlySet<string>): Promise<string[]> {
  const found = new Set<string>()

  async function walk(dir: string, depth: number): Promise<void> {
    const entries = await io.list(dir).catch(() => [])
    const git = entries.find(entry => entry.name === '.git')
    if (git?.kind === 'dir') {
      found.add(dir)
      return
    }
    if (git?.kind === 'file') {
      const text = await io.readFile(joinPath(dir, '.git')).catch(() => '')
      const meaning = classifyGitFile(dir, text)
      if (meaning.kind === 'worktree') found.add(meaning.mainRepo)
      return
    }
    if (depth >= maxDepth) return
    const children = entries.filter(
      entry => entry.kind === 'dir' && !/^[._]/.test(entry.name) && !ignore.has(entry.name),
    )
    await Promise.all(children.map(child => walk(joinPath(dir, child.name), depth + 1)))
  }

  const rootEntries = await io.list(root).catch(() => [])
  if (rootEntries.some(entry => entry.name === '.git')) return [] // a single repo: the engine covers it
  await walk(root, 0)
  return [...found].sort()
}

// ---------------------------------------------------------------- parsing

/** Parses `git status --porcelain=v2 --branch`. */
export function parseStatus(path: string, stdout: string): TreeStatus {
  const tree = emptyTree(path)
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length)
      tree.head = oid === '(initial)' ? null : oid.slice(0, 7)
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      tree.branch = head === '(detached)' ? null : head
    } else if (line.startsWith('# branch.upstream ')) {
      tree.upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const [ahead = '+0', behind = '-0'] = line.slice('# branch.ab '.length).split(' ')
      tree.ahead = Number(ahead.slice(1)) || 0
      tree.behind = Number(behind.slice(1)) || 0
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const fields = line.split(' ')
      const xy = fields[1] ?? '..'
      const pathStart = line.startsWith('1 ') ? 8 : 9
      const filePath = fields.slice(pathStart).join(' ').split('\t')[0] ?? ''
      if (xy[0] !== '.') tree.staged++
      if (xy[1] !== '.') tree.unstaged++
      addFile(tree, xy.replace(/\./g, ' '), filePath)
    } else if (line.startsWith('u ')) {
      tree.conflicted++
      addFile(tree, 'UU', line.split(' ').slice(10).join(' '))
    } else if (line.startsWith('? ')) {
      tree.untracked++
      addFile(tree, '??', line.slice(2))
    }
  }
  return tree
}

function addFile(tree: TreeStatus, code: string, filePath: string): void {
  if (tree.files.length < MAX_FILES) tree.files.push(`${code} ${filePath}`)
}

export function emptyTree(path: string): TreeStatus {
  return {
    path,
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    files: [],
    isPrunable: false,
    error: null,
  }
}

export type WorktreeEntry = { path: string; isBare: boolean; isPrunable: boolean }

/** Parses `git worktree list --porcelain`; the first entry is the main one. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  return stdout
    .split('\n\n')
    .map(block => block.split('\n'))
    .filter(lines => lines[0]?.startsWith('worktree '))
    .map(lines => ({
      path: (lines[0] ?? '').slice('worktree '.length),
      isBare: lines.includes('bare'),
      isPrunable: lines.some(line => line.startsWith('prunable')),
    }))
}

// ---------------------------------------------------------------- reading

/**
 * The environment every git child runs in: the C locale, so output parses
 * the same everywhere, and no credential prompt, so a fetch fails instead of
 * hanging on a repo that needs a password.
 */
export const GIT_ENV = { LC_ALL: 'C', LANGUAGE: '', GIT_TERMINAL_PROMPT: '0' }

/**
 * Runs git in one repo. `--no-optional-locks` keeps `git status` from taking
 * the index lock, so a background refresh never collides with the person's
 * own git commands or Claude's.
 */
async function git(io: Io, path: string, args: string[], timeoutMs = 15_000) {
  const argv = ['git', '--no-optional-locks', '-C', path, ...args]
  return io.run(argv, { timeoutMs, env: GIT_ENV }).catch(error => ({
    exitCode: 1,
    stdout: '',
    stderr: String(error),
  }))
}

async function readTree(io: Io, path: string): Promise<TreeStatus> {
  const ran = await git(io, path, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'])
  if (ran.exitCode !== 0) return { ...emptyTree(path), error: ran.stderr.trim().split('\n')[0] || 'git status failed' }
  return parseStatus(path, ran.stdout)
}

async function readDefaultBranch(io: Io, path: string): Promise<string | null> {
  const origin = await git(io, path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (origin.exitCode === 0) return origin.stdout.trim().replace(/^origin\//, '')
  for (const name of ['main', 'master']) {
    const local = await git(io, path, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    if (local.exitCode === 0) return name
  }
  return null
}

export async function readRepo(io: Io, root: string, path: string): Promise<RepoStatus> {
  const [tree, listed, log, defaultBranch] = await Promise.all([
    readTree(io, path),
    git(io, path, ['worktree', 'list', '--porcelain']),
    git(io, path, ['log', `-${RECENT_COMMITS}`, '--format=%h %s']),
    readDefaultBranch(io, path),
  ])
  const linked = parseWorktreeList(listed.stdout).filter(entry => !entry.isBare && entry.path !== path)
  const worktrees = await Promise.all(
    linked.map(async entry =>
      entry.isPrunable ? { ...emptyTree(entry.path), isPrunable: true } : readTree(io, entry.path),
    ),
  )
  return {
    name: relativePath(root, path),
    path,
    defaultBranch,
    recent: log.exitCode === 0 ? log.stdout.split('\n').filter(Boolean) : [],
    tree,
    worktrees,
  }
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export async function scanAll(io: Io, root: string, maxDepth: number, ignore: ReadonlySet<string>): Promise<RepoStatus[]> {
  const paths = await findRepos(io, root, maxDepth, ignore)
  return mapLimit(paths, CONCURRENCY, path => readRepo(io, root, path))
}

export async function fetchAll(io: Io, repos: readonly RepoStatus[]): Promise<string[]> {
  const failed = await mapLimit(repos, CONCURRENCY, async repo => {
    const ran = await git(io, repo.path, ['fetch', '--all', '--prune', '--quiet'], 120_000)
    return ran.exitCode === 0 ? null : repo.name
  })
  return failed.filter((name): name is string => name !== null)
}

// ---------------------------------------------------------------- text

export function isDirty(tree: TreeStatus): boolean {
  return tree.staged + tree.unstaged + tree.untracked + tree.conflicted > 0
}

/** Changed, ahead or unreadable. A repo that is only behind its upstream waits for /repos. */
export function needsAttention(repo: RepoStatus): boolean {
  return [repo.tree, ...repo.worktrees].some(tree => isDirty(tree) || tree.ahead > 0 || tree.error !== null)
}

/** `main* ↑2 ↓1`: the branch, a star when dirty, and the distance to upstream. */
export function shortState(tree: TreeStatus): string {
  if (tree.isPrunable) return 'missing (prunable)'
  if (tree.error) return 'unreadable'
  const branch = tree.branch ?? `detached@${tree.head ?? '?'}`
  const parts = [branch + (isDirty(tree) ? '*' : '')]
  if (tree.ahead) parts.push(`↑${tree.ahead}`)
  if (tree.behind) parts.push(`↓${tree.behind}`)
  return parts.join(' ')
}

/** Nothing for a tree git couldn't read: its counts are empty, not clean. */
export function changeSummary(tree: TreeStatus): string {
  if (tree.error || tree.isPrunable) return ''
  const parts: string[] = []
  if (tree.conflicted) parts.push(`${tree.conflicted} conflicted`)
  if (tree.staged) parts.push(`${tree.staged} staged`)
  if (tree.unstaged) parts.push(`${tree.unstaged} modified`)
  if (tree.untracked) parts.push(`${tree.untracked} untracked`)
  return parts.length ? parts.join(', ') : 'clean'
}

function describeTree(tree: TreeStatus, indent: string): string[] {
  const lines: string[] = []
  const upstream = tree.upstream ? ` (tracking ${tree.upstream})` : ' (no upstream)'
  lines.push(`${indent}Branch: ${shortState(tree)}${tree.error || tree.isPrunable ? '' : upstream}`)
  if (tree.error) lines.push(`${indent}Error: ${tree.error}`)
  if (tree.error || tree.isPrunable) return lines
  lines.push(`${indent}Status: ${changeSummary(tree)}`)
  for (const file of tree.files) lines.push(`${indent}  ${file}`)
  const total = tree.staged + tree.unstaged + tree.untracked + tree.conflicted
  if (total > tree.files.length) lines.push(`${indent}  … and ${total - tree.files.length} more`)
  return lines
}

export function describeRepo(repo: RepoStatus): string {
  const lines = [`## ${repo.name}  (${repo.path})`]
  if (repo.defaultBranch) lines.push(`Main branch (you will usually use this for PRs): ${repo.defaultBranch}`)
  lines.push(...describeTree(repo.tree, ''))
  if (repo.recent.length) {
    lines.push('Recent commits:')
    lines.push(...repo.recent.map(commit => `  ${commit}`))
  }
  if (repo.worktrees.length) {
    lines.push('Linked worktrees:')
    for (const tree of repo.worktrees) {
      lines.push(`- ${tree.path}`)
      lines.push(...describeTree(tree, '  '))
    }
  }
  return lines.join('\n')
}

export function formatSnapshot(root: string, repos: readonly RepoStatus[]): string {
  const header = [
    `This is the git status of every repo in the multi-repo workspace ${root} at the start of the conversation.`,
    'Note that this status is a snapshot in time: changes since then arrive with later prompts,',
    'and the repo_status tool reads it fresh.',
  ].join(' ')
  return [header, ...repos.map(describeRepo)].join('\n\n')
}

/** One string per tree that changes whenever anything shown about it does. */
export function fingerprints(repos: readonly RepoStatus[]): Record<string, string> {
  const prints: Record<string, string> = {}
  for (const repo of repos) {
    for (const tree of [repo.tree, ...repo.worktrees]) {
      prints[tree.path] = JSON.stringify([shortState(tree), tree.head, tree.files])
    }
  }
  return prints
}

/** Lines for the trees whose state changed since `before`; empty when none did. */
export function formatChanges(before: Record<string, string>, repos: readonly RepoStatus[]): string[] {
  const now = fingerprints(repos)
  const lines: string[] = []
  for (const repo of repos) {
    for (const tree of [repo.tree, ...repo.worktrees]) {
      if (before[tree.path] === now[tree.path]) continue
      const label = tree === repo.tree ? repo.name : `${repo.name} worktree ${tree.path}`
      const isNew = before[tree.path] === undefined ? ' (new)' : ''
      const files = tree.files.slice(0, 5).join(', ')
      const state = [shortState(tree), changeSummary(tree)].filter(Boolean).join(', ')
      lines.push(`- ${label}${isNew}: ${state}${files ? ` (${files})` : ''}`)
    }
  }
  for (const path of Object.keys(before)) {
    if (now[path] === undefined) lines.push(`- ${path}: no longer present`)
  }
  return lines
}

/** A piece of a row in the pane and table: its text and the theme colour the pane draws it in. */
export type Mark = { text: string; color: string }

/**
 * A tree's state as short markers, each with its own symbol so it reads
 * without colour: `!` conflicted, `+` staged, `~` modified, `?` untracked,
 * `↑`/`↓` ahead/behind, `✓` clean and in step. The branch comes last, so a
 * narrow pane cuts it before the markers.
 */
export function marks(tree: TreeStatus, defaultBranch: string | null): Mark[] {
  if (tree.isPrunable) return [{ text: '✗ missing', color: 'error' }]
  if (tree.error) return [{ text: '✗ unreadable', color: 'error' }]
  const out: Mark[] = []
  if (tree.conflicted) out.push({ text: `!${tree.conflicted}`, color: 'error' })
  if (tree.staged) out.push({ text: `+${tree.staged}`, color: 'success' })
  if (tree.unstaged) out.push({ text: `~${tree.unstaged}`, color: 'warning' })
  if (tree.untracked) out.push({ text: `?${tree.untracked}`, color: 'warning' })
  if (tree.ahead) out.push({ text: `↑${tree.ahead}`, color: 'suggestion' })
  if (tree.behind) out.push({ text: `↓${tree.behind}`, color: 'inactive' })
  if (out.length === 0) out.push({ text: '✓', color: 'success' })
  const isDefault = tree.branch !== null && tree.branch === defaultBranch
  out.push({ text: `⎇ ${tree.branch ?? `@${tree.head ?? '?'}`}`, color: isDefault ? 'inactive' : 'merged' })
  return out
}

/** A line of the repo tree: a folder, a repo or one of its worktrees, after `tree`'s connectors. */
export type TreeRow = {
  prefix: string
  kind: 'folder' | 'repo' | 'worktree'
  name: string
  /** The folder's or repo's path under the root, or the worktree's own path: what a fold is keyed by. */
  path: string
  tree: TreeStatus | null
  defaultBranch: string | null
  /** For a folded folder, how many repos it hides; otherwise 0. */
  foldedRepos: number
}

type TreeNode = { children: Map<string, TreeNode>; repo: RepoStatus | null }

function countRepos(node: TreeNode): number {
  let count = node.repo ? 1 : 0
  for (const child of node.children.values()) count += countRepos(child)
  return count
}

/**
 * The repos as `tree` draws folders: each folder once, its repos beneath it,
 * and each repo's worktrees beneath the repo. A chain of folders holding only
 * one folder each is drawn on one line (`group/a/b/`). A folder whose path is
 * in `folded` is drawn without what is inside it.
 */
export function treeRows(repos: readonly RepoStatus[], folded: ReadonlySet<string> = new Set()): TreeRow[] {
  const top: TreeNode = { children: new Map(), repo: null }
  for (const repo of repos) {
    let node = top
    for (const part of repo.name.split('/')) {
      let child = node.children.get(part)
      if (!child) node.children.set(part, (child = { children: new Map(), repo: null }))
      node = child
    }
    node.repo = repo
  }

  const rows: TreeRow[] = []
  function walk(node: TreeNode, prefix: string, under: string): void {
    const entries = [...node.children]
    entries.forEach(([part, child], index) => {
      const isLast = index === entries.length - 1
      const branch = prefix + (isLast ? '└── ' : '├── ')
      const below = prefix + (isLast ? '    ' : '│   ')
      const repo = child.repo
      if (repo) {
        const { defaultBranch } = repo
        rows.push({ prefix: branch, kind: 'repo', name: part, path: repo.name, tree: repo.tree, defaultBranch, foldedRepos: 0 })
        repo.worktrees.forEach((tree, at) => {
          const connector = at === repo.worktrees.length - 1 ? '└── ' : '├── '
          const name = worktreeName(tree.path)
          rows.push({ prefix: below + connector, kind: 'worktree', name, path: tree.path, tree, defaultBranch, foldedRepos: 0 })
        })
        return
      }
      let name = part
      let folder = child
      while (folder.children.size === 1) {
        const [only] = folder.children
        if (!only || only[1].repo) break
        name += `/${only[0]}`
        folder = only[1]
      }
      const path = under + name
      const isFolded = folded.has(path)
      const foldedRepos = isFolded ? countRepos(folder) : 0
      rows.push({ prefix: branch, kind: 'folder', name: `${name}/`, path, tree: null, defaultBranch: null, foldedRepos })
      if (!isFolded) walk(folder, below, `${path}/`)
    })
  }
  walk(top, '', '')
  return rows
}

/** The repo tree as plain text, for the transcript. */
export function formatTable(repos: readonly RepoStatus[]): string {
  if (repos.length === 0) return 'No git repos found under the workspace root.'
  return treeRows(repos)
    .map(row => {
      const state = row.tree ? marks(row.tree, row.defaultBranch).map(mark => mark.text) : []
      return [row.prefix + row.name, ...state].join(' ')
    })
    .join('\n')
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** What opens the band: the repo the session is in, then counts across the workspace. */
export function summaryLine(repos: readonly RepoStatus[], cwd: string): string {
  const trees = repos.flatMap(repo => [repo.tree, ...repo.worktrees])
  const dirty = trees.filter(isDirty).length
  const ahead = trees.filter(tree => tree.ahead > 0).length
  const worktrees = repos.reduce((sum, repo) => sum + repo.worktrees.length, 0)
  const parts = [`⎇ ${plural(repos.length, 'repo')}`]
  if (worktrees) parts.push(plural(worktrees, 'worktree'))
  if (dirty) parts.push(`${dirty} dirty`)
  if (ahead) parts.push(`${ahead} ahead`)
  const active = activeTree(repos, cwd)
  if (active) parts.unshift(`▸ ${active.label} ${shortState(active.tree)}`)
  return parts.join(' · ')
}

/** The repo or worktree the session's directory is in, if any. */
export function activeTree(repos: readonly RepoStatus[], cwd: string): { label: string; tree: TreeStatus } | null {
  let best: { label: string; tree: TreeStatus } | null = null
  for (const repo of repos) {
    for (const tree of [repo.tree, ...repo.worktrees]) {
      const isInside = cwd === tree.path || cwd.startsWith(tree.path + '/')
      if (isInside && (!best || tree.path.length > best.tree.path.length)) {
        best = { label: tree === repo.tree ? repo.name : `${repo.name}:wt`, tree }
      }
    }
  }
  return best
}

export const GUIDANCE = `# Multi-repo workspace

The working directory is not itself a git repository: it is a workspace that holds several independent git repos, each listed with its status in the multiRepoStatus context. Treat each repo as you would the single repo of an ordinary session:

- Run git inside the repo it concerns: \`git -C <repo> <command>\`, or \`cd <repo> && <command>\` in one Bash call. Git commands at the workspace root fail, because it is not a repository.
- Branches, commits, pushes and pull requests belong to one repo each. When a change spans repos, make one commit (and one PR) per repo, and say which repo each one is in.
- Read each repo's own CLAUDE.md, README and conventions before changing it; they may differ between repos.
- Work on independent repos in parallel: batch the tool calls for different repos in one message, or give each repo its own subagent.
- Parallel tasks in the same repo each get their own git worktree (\`git -C <repo> worktree add <path> -b <branch>\`, or the EnterWorktree tool with the repo's \`path\`, which accepts a repo nested in the workspace). Never switch the branch of a worktree another task is using; check the repo's linked worktrees first.
- After leaving a worktree (ExitWorktree), the workspace root is the session's directory again.
- The status shown is a snapshot. Before committing, pushing or switching branches, check fresh status with the repo_status tool or \`git -C <repo> status\`.`
