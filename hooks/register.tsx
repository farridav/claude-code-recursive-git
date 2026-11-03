import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { RepoStatus } from '../types'
import type { Io } from './git'
import {
  DEFAULT_IGNORE,
  GUIDANCE,
  changeSummary,
  describeRepo,
  fetchAll,
  fingerprints,
  formatChanges,
  formatSnapshot,
  formatTable,
  needsAttention,
  relativePath,
  scanAll,
  shortState,
  statusLine,
} from './git'

const PANE = 'multi-repo'
const TOOL = 'mcp__multi-repo__repo_status'
const REFRESH_AFTER = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'])
const REFRESH_DEBOUNCE_MS = 1_500
const REFRESH_EVERY_MS = 60_000
const STALE_AFTER_MS = 10_000

// Bump the shape tag when RepoStatus changes: it declines what an older version stored.
type Session = Io & {
  now: () => Promise<number>
  cwd: () => Promise<string>
  root: () => Promise<string | null>
  saveRepos: (repos: RepoStatus[]) => Promise<unknown>
  status: (text: string | undefined) => void
  after: (ms: number, fn: () => void) => Timer
}

const reposAtom = atom({ plugin: 'multi-repo', key: 'repos' } as const, [], { shape: 'repos-1' })
const rootAtom = atom({ plugin: 'multi-repo', key: 'workspaceRoot' } as const, null)
const reportedAtom = atom({ plugin: 'multi-repo', key: 'reported' } as const, null)

export const register: Register = (on, options) => {
  const maxDepth = Number(options.scanDepth ?? 4)
  const showBand = options.showBand !== false
  const extraIgnore = String(options.ignore ?? '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
  const ignore = new Set([...DEFAULT_IGNORE, ...extraIgnore])

  // Module variables start over on a reload; session.start runs again then.
  // `session` holds closures over session.start's engine, for timers and other hooks.
  let session: Session | null = null
  let isActive = false
  let scanning: Promise<RepoStatus[]> | null = null
  let lastScanAt = 0
  let pendingRefresh: Timer | null = null

  async function refresh(): Promise<RepoStatus[]> {
    const s = session
    if (!s) return []
    scanning ??= (async () => {
      const root = await s.root()
      if (!root) return []
      const repos = await scanAll(s, root, maxDepth, ignore)
      await s.saveRepos(repos)
      lastScanAt = await s.now()
      s.status(repos.length ? statusLine(repos, await s.cwd()) : undefined)
      return repos
    })().finally(() => {
      scanning = null
    })
    return scanning
  }

  async function freshRepos(cached: RepoStatus[]): Promise<RepoStatus[]> {
    const isStale = session !== null && (await session.now()) - lastScanAt > STALE_AFTER_MS
    return isStale ? refresh() : cached
  }

  function scheduleRefresh(): void {
    pendingRefresh?.cancel()
    pendingRefresh = session?.after(REFRESH_DEBOUNCE_MS, () => void refresh()) ?? null
  }

  // ------------------------------------------------------------ session

  on('session.start', async ($, e, next) => {
    session = {
      list: path => $.fs.list(path),
      readFile: path => $.fs.read(path),
      run: (argv, init) => $.process.run(argv, init),
      now: () => $.clock.now(),
      cwd: () => $.session.cwd(),
      root: () => read($, rootAtom),
      saveRepos: repos => update($, reposAtom, () => repos),
      status: text => $.ui.status(text),
      after: (ms, fn) => $.clock.after(ms, fn),
    }
    if (!(await read($, rootAtom))) {
      // Fixed for the session: EnterWorktree later moves the session's own root.
      const start = await $.session.root()
      await update($, rootAtom, () => start)
    }
    const repos = await refresh()
    isActive = repos.length > 0
    if (isActive) {
      await $.tool.register({
        name: 'repo_status',
        description:
          'Fresh git status of the repos in this multi-repo workspace: branch, upstream distance, changed files, recent commits and linked worktrees. Pass `repo` (its path relative to the workspace root, as listed in multiRepoStatus) for one repo; leave it out for all.',
        inputSchema: {
          type: 'object',
          properties: { repo: { type: 'string', description: 'Repo path relative to the workspace root' } },
        },
        isDeferred: false,
      })
      await $.command.register({ name: 'repos', description: 'Show the git status of every repo in the workspace' })
      await $.command.register({ name: 'repos-fetch', description: 'git fetch --all --prune in every workspace repo' })
      $.clock.every(REFRESH_EVERY_MS, () => void refresh())
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear starts a new conversation: it gets a new snapshot.
    if (e.reason === 'clear') await update($, reportedAtom, () => null)
    return next(e)
  })

  // ------------------------------------------------------------ what the model reads

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isActive) return composed
    return {
      sections: [...composed.sections, { id: 'multi-repo:guidance', text: GUIDANCE, scope: 'session' as const }],
    }
  })

  on('prompt.section', { name: 'env_info_simple' }, async ($, e, next) => {
    const section = await next(e)
    if (!isActive || section.text === null) return section
    return {
      text: section.text.replace(
        /Is a git repository: \w+/,
        'Is a git repository: no, the root is a multi-repo workspace (see "Multi-repo workspace")',
      ),
    }
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    if (!isActive) return result
    const root = (await read($, rootAtom)) ?? ''
    const repos = await read($, reposAtom)
    // Only the first telling sets the baseline; later calls would hide changes.
    if ((await read($, reportedAtom)) === null) await update($, reportedAtom, () => fingerprints(repos))
    return { ...result, blocks: [...result.blocks, { name: 'multiRepoStatus', text: formatSnapshot(root, repos) }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isActive || e.command || e.isMeta) return next(e)
    const before = await read($, reportedAtom)
    if (before === null) return next(e)
    const repos = await freshRepos(await read($, reposAtom))
    const lines = formatChanges(before, repos)
    if (lines.length === 0) return next(e)
    await update($, reportedAtom, () => fingerprints(repos))
    const note = ['Git changes in the workspace repos since the last status you were given:', ...lines].join('\n')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // ------------------------------------------------------------ tools

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const repos = await refresh()
    const asked = (e as unknown as { repo?: unknown }).repo
    const wanted = typeof asked === 'string' ? asked.replace(/^\.\//, '').replace(/\/+$/, '') : ''
    const picked = wanted ? repos.filter(repo => repo.name === wanted || repo.path === wanted) : repos
    if (wanted && picked.length === 0) {
      const names = repos.map(repo => repo.name).join(', ')
      return { result: `No repo "${wanted}" in the workspace. Repos: ${names}` }
    }
    return { result: picked.map(describeRepo).join('\n\n') }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (isActive && REFRESH_AFTER.has(String(e.tool))) scheduleRefresh()
    return ran
  })

  // ------------------------------------------------------------ commands

  on('command.run', { command: 'repos' }, async $ => {
    const repos = await refresh()
    await $.ui.open({ id: PANE, title: 'Repos' })
    return { text: formatTable((await read($, rootAtom)) ?? '', repos) }
  })

  on('command.run', { command: 'repos-fetch' }, async $ => {
    const failed = session ? await fetchAll(session, await read($, reposAtom)) : []
    const repos = await refresh()
    const behind = repos.filter(repo => repo.tree.behind > 0).map(repo => repo.name)
    const lines = [`Fetched ${repos.length - failed.length} of ${repos.length} repos.`]
    if (failed.length) lines.push(`Fetch failed in: ${failed.join(', ')}`)
    if (behind.length) lines.push(`Behind upstream: ${behind.join(', ')}`)
    return { text: lines.join('\n') }
  })

  // ------------------------------------------------------------ drawing

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isActive || !showBand || e.props.hasSurvey) return next(e)
    const repos = (await read($, reposAtom)).filter(needsAttention)
    if (repos.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const chips = repos.map(repo => {
      const extra = repo.worktrees.length ? ` +${repo.worktrees.length}wt` : ''
      return `${repo.name} ${shortState(repo.tree)}${extra}`
    })
    let line = ''
    let shown = 0
    for (const chip of chips) {
      const more = chips.length - shown - 1
      const room = e.props.bodyColumns - (more > 0 ? ` +${more} more`.length : 0)
      const joined = line ? `${line}  ${chip}` : chip
      if (joined.length > room) break
      line = joined
      shown++
    }
    const rest = chips.length - shown
    return (
      <Box>
        <Text dimColor wrap="truncate">
          {line || chips[0]}
          {rest > 0 && shown > 0 ? ` +${rest} more` : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const repos = await read($, reposAtom)
    const root = (await read($, rootAtom)) ?? ''
    return (
      <Box flexDirection="column">
        <Box>
          <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refresh()} />
          <Text> </Text>
          <Button
            key="fetch"
            hotkey="f"
            label="Fetch all"
            onPress={async () => {
              const failed = session ? await fetchAll(session, await read($, reposAtom)) : []
              await refresh()
              $.ui.toast(failed.length ? `Fetch failed in: ${failed.join(', ')}` : 'Fetched every repo')
            }}
          />
        </Box>
        <Text dimColor wrap="truncate">
          {repos.length} repos under {root}
        </Text>
        {repos.length === 0 && <Text dimColor>No git repos found.</Text>}
        {repos.map(repo => (
          <Box flexDirection="column">
            <Text wrap="truncate">
              <Text bold>{repo.name}</Text> {shortState(repo.tree)} <Text dimColor>{changeSummary(repo.tree)}</Text>
            </Text>
            {repo.worktrees.map(tree => (
              <Text wrap="truncate" dimColor={!needsAttention({ ...repo, tree, worktrees: [] })}>
                {'  └ '}
                {relativePath(root, tree.path)} {shortState(tree)} {changeSummary(tree)}
              </Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
