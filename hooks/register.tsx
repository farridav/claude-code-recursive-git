import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { RepoStatus } from '../types'
import type { Io, Linked } from './git'
import {
  DEFAULT_IGNORE,
  GUIDANCE,
  describeRepo,
  fetchAll,
  fingerprints,
  formatChanges,
  formatSnapshot,
  formatTable,
  mergedWorktrees,
  marks,
  plural,
  pruneMissing,
  removeWorktrees,
  needsAttention,
  scanAll,
  shortState,
  summaryLine,
  treeRows,
  unreadableWorktrees,
  worktreeName,
} from './git'

const PANE = 'multi-repo'
// A RegExp, not the name: the tool is typed only in sessions where it is registered.
const TOOL = /^mcp__multi-repo__repo_status$/
const REFRESH_AFTER = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'])
const REFRESH_DEBOUNCE_MS = 1_500
const REFRESH_EVERY_MS = 60_000
const STALE_AFTER_MS = 10_000

// Bump the shape tag when RepoStatus changes: it declines what an older version stored.
type Session = Io & {
  now: () => Promise<number>
  root: () => Promise<string | null>
  saveRepos: (repos: RepoStatus[]) => Promise<unknown>
  after: (ms: number, fn: () => void) => Timer
}

const reposAtom = atom({ plugin: 'multi-repo', key: 'repos' } as const, [], { shape: 'repos-1' })
const rootAtom = atom({ plugin: 'multi-repo', key: 'workspaceRoot' } as const, null)
const reportedAtom = atom({ plugin: 'multi-repo', key: 'reported' } as const, null)
const foldedAtom = atom({ plugin: 'multi-repo', key: 'folded' } as const, [])
const busyAtom = atom({ plugin: 'multi-repo', key: 'busy' } as const, null)

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
      root: () => read($, rootAtom),
      saveRepos: repos => update($, reposAtom, () => repos),
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
      await $.ui.open({ id: PANE, title: 'Repos' })
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
    const root = (await read($, rootAtom)) ?? ''
    return { text: `Repos under ${root}\n${formatTable(repos)}` }
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
    const all = await read($, reposAtom)
    if (all.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // The summary always shows; the repos needing attention follow while they fit.
    const chips = all.filter(needsAttention).map(repo => {
      const extra = repo.worktrees.length ? ` +${repo.worktrees.length}wt` : ''
      return `${repo.name} ${shortState(repo.tree)}${extra}`
    })
    let line = summaryLine(all, await $.session.cwd())
    let shown = 0
    for (const chip of chips) {
      const more = chips.length - shown - 1
      const room = e.props.bodyColumns - (more > 0 ? ` +${more} more`.length : 0)
      const joined = `${line}   ${chip}`
      if (joined.length > room) break
      line = joined
      shown++
    }
    const rest = chips.length - shown
    return (
      <Box>
        <Text dimColor wrap="truncate">
          {line}
          {rest > 0 ? ` +${rest} more` : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const repos = await read($, reposAtom)
    const root = (await read($, rootAtom)) ?? ''
    const folded = await read($, foldedAtom)
    const busy = await read($, busyAtom)
    const toggle = (path: string) =>
      update($, foldedAtom, paths => (paths.includes(path) ? paths.filter(one => one !== path) : [...paths, path]))

    // Runs one job at a time, shows it in the pane while it runs, and toasts what it did.
    const job = (doing: string, work: (s: Session) => Promise<string>) => async () => {
      if (!session || (await read($, busyAtom))) return
      await update($, busyAtom, () => doing)
      try {
        $.ui.toast(await work(session))
      } catch (error) {
        $.ui.toast(`${doing} failed: ${String(error)}`)
      } finally {
        await update($, busyAtom, () => null)
      }
    }

    // Confirms, removes, then logs each removal to the transcript so there is a record.
    const removeAll = async (s: Session, found: Linked[], what: string, repair: boolean) => {
      if (found.length === 0) return `No ${what} worktrees to remove`
      const names = found.map(({ tree }) => worktreeName(tree.path)).join(', ')
      const question = `Remove ${plural(found.length, `${what} worktree`)} (${names}) and keep their branches?`
      const answer = await $.ui.ask(question, ['Remove', 'Cancel']).catch(() => 'Cancel')
      if (answer !== 'Remove') return 'Nothing removed'
      const { removed, kept } = await removeWorktrees(s, found, repair)
      await refresh()
      for (const { repo, tree } of removed) $.ui.log(`Removed worktree ${tree.path} (${repo.name})`)
      for (const { worktree, reason } of kept) $.ui.log(`Kept worktree ${worktree.tree.path}: ${reason}`)
      return [`Removed ${plural(removed.length, 'worktree')}`, kept.length ? `kept ${kept.length}, see the transcript` : '']
        .filter(Boolean)
        .join('; ')
    }

    const cwd = await $.session.cwd()
    const buttons = [
      {
        key: 'refresh',
        hotkey: 'r',
        label: 'Refresh',
        doing: 'Refreshing',
        work: async () => `Refreshed ${plural((await refresh()).length, 'repo')}`,
      },
      {
        key: 'fetch',
        hotkey: 'f',
        label: 'Fetch all',
        doing: 'Fetching',
        work: async (s: Session) => {
          const failed = await fetchAll(s, await read($, reposAtom))
          const behind = (await refresh()).filter(repo => repo.tree.behind > 0).length
          if (failed.length) return `Fetch failed in: ${failed.join(', ')}`
          return `Fetched every repo${behind ? `; ${plural(behind, 'repo')} behind` : ''}`
        },
      },
      {
        key: 'prune',
        hotkey: 'p',
        label: 'Prune missing',
        doing: 'Pruning',
        work: async (s: Session) => {
          const { pruned, failed } = await pruneMissing(s, await read($, reposAtom))
          await refresh()
          if (failed.length) return `Prune failed in: ${failed.join(', ')}`
          return pruned ? `Pruned ${plural(pruned, 'missing worktree')}` : 'No missing worktrees to prune'
        },
      },
      {
        key: 'merged',
        hotkey: 'm',
        label: 'Remove merged',
        doing: 'Removing merged worktrees',
        work: async (s: Session) => {
          const merged = await mergedWorktrees(s, await read($, reposAtom))
          // Never the worktree this session is working in.
          const found = merged.filter(({ tree }) => cwd !== tree.path && !cwd.startsWith(`${tree.path}/`))
          return removeAll(s, found, 'merged', false)
        },
      },
      {
        key: 'unreadable',
        hotkey: 'u',
        label: 'Remove unreadable',
        doing: 'Removing unreadable worktrees',
        work: async (s: Session) => removeAll(s, unreadableWorktrees(await read($, reposAtom)), 'unreadable', true),
      },
    ]

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap={1}>
          {buttons.map(button => (
            <Button
              key={button.key}
              hotkey={button.hotkey}
              label={button.label}
              dimColor={busy !== null}
              onPress={job(button.doing, button.work)}
            />
          ))}
        </Box>
        {busy ? (
          <Text color="warning" wrap="truncate">
            {busy}…
          </Text>
        ) : (
          <Text dimColor wrap="truncate">
            {plural(repos.length, 'repo')} under {root}
          </Text>
        )}
        {repos.length === 0 && <Text dimColor>No git repos found.</Text>}
        {treeRows(repos, new Set(folded)).map(row =>
          row.kind === 'folder' ? (
            <Box>
              <Text dimColor>{row.prefix}</Text>
              <Button plain key={`fold:${row.path}`} label={row.name} onPress={() => void toggle(row.path)}>
                <Text bold color="suggestion">
                  {row.foldedRepos ? '▸ ' : '▾ '}
                  {row.name}
                </Text>
                {row.foldedRepos > 0 && <Text dimColor>{` ${plural(row.foldedRepos, 'repo')}`}</Text>}
              </Button>
            </Box>
          ) : (
            <Text wrap="truncate">
              <Text dimColor>{row.prefix}</Text>
              <Text bold={row.kind === 'repo'} italic={row.kind === 'worktree'}>
                {row.name}
              </Text>
              {row.tree &&
                marks(row.tree, row.defaultBranch).map(mark => <Text color={mark.color}>{` ${mark.text}`}</Text>)}
            </Text>
          ),
        )}
      </Box>
    )
  })
}
