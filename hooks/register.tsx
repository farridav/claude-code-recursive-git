import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { RepoStatus, TreeStatus } from '../types'
import type { Io, Linked, TreeRow } from './git'
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
  switchBranch,
  switchableBranches,
  treeRows,
  unreadableWorktrees,
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
  saveMerged: (paths: string[]) => Promise<unknown>
  after: (ms: number, fn: () => void) => Timer
}

const reposAtom = atom({ plugin: 'multi-repo', key: 'repos' } as const, [], { shape: 'repos-2' })
const rootAtom = atom({ plugin: 'multi-repo', key: 'workspaceRoot' } as const, null)
const reportedAtom = atom({ plugin: 'multi-repo', key: 'reported' } as const, null)
const foldedAtom = atom({ plugin: 'multi-repo', key: 'folded' } as const, [])
const busyAtom = atom({ plugin: 'multi-repo', key: 'busy' } as const, null)
const mergedAtom = atom({ plugin: 'multi-repo', key: 'merged' } as const, [])
const pickingAtom = atom({ plugin: 'multi-repo', key: 'picking' } as const, null)

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
  // Set before the first await, so a second press can't start a job alongside the first.
  let isBusy = false

  async function refresh(): Promise<RepoStatus[]> {
    const s = session
    if (!s) return []
    scanning ??= (async () => {
      const root = await s.root()
      if (!root) return []
      const repos = await scanAll(s, root, maxDepth, ignore)
      await s.saveRepos(repos)
      // Only clean worktrees on another branch are checked, so this stays a few git calls.
      await s.saveMerged((await mergedWorktrees(s, repos)).map(({ tree }) => tree.path))
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
      saveMerged: paths => update($, mergedAtom, () => paths),
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

  // Claude Code reports the root as "not a git repository", which is true but
  // reads as "no git here". This one line says the repos are below it instead.
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
  }).catch(($, e, next) => next(e)) // a failed git read never holds up a prompt: it goes as typed

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
  }).catch(() => ({ result: 'Could not read the git status of the workspace repos.' }))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (isActive && REFRESH_AFTER.has(String(e.tool))) scheduleRefresh()
    return ran
  }).catch(($, e, next) => next(e)) // the tool call itself always goes ahead untouched

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
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Mobile draws no Select, so there the branch is plain text.
    const Select = 'Select' in elements ? elements.Select : null
    const repos = await read($, reposAtom)
    const root = (await read($, rootAtom)) ?? ''
    const folded = await read($, foldedAtom)
    const busy = await read($, busyAtom)
    const merged = await read($, mergedAtom)
    const picking = await read($, pickingAtom)
    const toggle = (path: string) =>
      update($, foldedAtom, paths => (paths.includes(path) ? paths.filter(one => one !== path) : [...paths, path]))

    // Runs one job at a time, shows it in the pane while it runs, and toasts what it did.
    const job = (doing: string, work: (s: Session) => Promise<string>) => async () => {
      if (!session || isBusy) return
      isBusy = true
      await update($, busyAtom, () => doing)
      try {
        $.ui.toast(await work(session))
      } catch (error) {
        $.ui.toast(`${doing} failed: ${String(error)}`)
      } finally {
        isBusy = false
        await update($, busyAtom, () => null)
      }
    }

    // Never the worktree this session is working in.
    const here = (await $.session.cwd()).replace(/\/+$/, '')
    const isHere = (path: string) => here === path || here.startsWith(`${path}/`)
    const isElsewhere = ({ tree }: Linked) => !isHere(tree.path)

    // Lists each worktree by its full path and asks. Then reads every repo
    // afresh and removes only those still in the state that was listed, and
    // notes each removal in the transcript so there is a record.
    const removeAll = async (s: Session, find: (repos: RepoStatus[]) => Promise<Linked[]>, what: string, repair: boolean) => {
      const found = (await find(await refresh())).filter(isElsewhere)
      if (found.length === 0) return `No ${what} worktrees to remove`
      const listed = found.map(({ repo, tree }) => `${tree.path} (${repo.name})`).join('; ')
      const question = `${listed}. Remove ${found.length === 1 ? 'this worktree, keeping its branch' : `these ${found.length} worktrees, keeping their branches`}? Git keeps any with uncommitted changes; files it ignores, such as build output or .env, go with the folder.`
      const answer = await $.ui.ask(question, ['Remove', 'Cancel']).catch(() => 'Cancel')
      if (answer !== 'Remove') return 'Nothing removed'
      const agreed = new Set(found.map(({ tree }) => tree.path))
      const still = (await find(await refresh())).filter(one => agreed.has(one.tree.path) && isElsewhere(one))
      const { removed, kept } = await removeWorktrees(s, still, repair)
      await refresh()
      for (const { repo, tree } of removed) $.ui.log(`Removed worktree ${tree.path} (${repo.name})`)
      for (const { worktree, reason } of kept) $.ui.log(`Kept worktree ${worktree.tree.path}: ${reason}`)
      return [`Removed ${plural(removed.length, 'worktree')}`, kept.length ? `kept ${kept.length}, see the transcript` : '']
        .filter(Boolean)
        .join('; ')
    }

    // A worktree other than the session's own, whose folder is still there, has a ✕ to remove it.
    const isRemovable = (row: TreeRow) =>
      row.kind === 'worktree' && row.tree !== null && !row.tree.isPrunable && !isHere(row.tree.path)

    const owner = new Map(repos.flatMap(repo => [repo.tree, ...repo.worktrees].map(tree => [tree.path, repo] as const)))

    const removeOne = (path: string) =>
      job('Removing worktree', async s => {
        const pick = async (all: RepoStatus[]) =>
          all.flatMap(repo =>
            repo.worktrees.filter(tree => tree.path === path && !tree.isPrunable).map(tree => ({ repo, tree })),
          )
        const tree = owner.get(path)?.worktrees.find(one => one.path === path)
        return removeAll(s, pick, 'such', tree?.error != null)
      })

    // Pressing a branch opens a dropdown of the tree's local branches in its place.
    const openPicker = (path: string) => async () => {
      const repo = owner.get(path)
      const tree = repo && [repo.tree, ...repo.worktrees].find(one => one.path === path)
      if (!session || !repo || !tree) return
      const branches = await switchableBranches(session, repo, tree)
      if (branches.length === 0) return $.ui.toast('No other local branch is free to switch to')
      await update($, pickingAtom, () => ({ path, branches }))
    }
    const closePicker = () => void update($, pickingAtom, () => null)

    // Writing a PR is the agent's work: this drafts the ask in the prompt box, to edit or send.
    const draftPullRequest = (path: string) => async () => {
      const repo = owner.get(path)
      const tree = repo && [repo.tree, ...repo.worktrees].find(one => one.path === path)
      if (!repo || !tree?.branch) return
      const into = repo.defaultBranch ?? 'the main branch'
      const ask = `Open a pull request for ${tree.branch} in ${repo.name} (${tree.path}) into ${into}. Push the branch if it needs it, and write the title and description from its commits.`
      const { text: draft } = await $.prompt.read()
      const filled = await $.prompt.fill(draft.trim() ? { text: `\n${ask}`, mode: 'append' } : { text: ask })
      if (!filled.isFilled) $.ui.toast('Could not reach the prompt box')
    }

    const switchTo = (path: string, branch: string) =>
      job('Switching branch', async s => {
        await update($, pickingAtom, () => null)
        const repo = owner.get(path)
        const tree = repo && [repo.tree, ...repo.worktrees].find(one => one.path === path)
        if (!repo || !tree) return 'That tree has gone'
        const from = tree.branch ?? `@${tree.head ?? '?'}`
        const refused = await switchBranch(s, path, branch)
        await refresh()
        if (refused) return `Stayed on ${from}: ${refused}`
        $.ui.log(`Switched ${tree.path} from ${from} to ${branch} (${repo.name})`)
        return `Switched to ${branch}`
      })

    // The branch, last, is a button that offers to switch the tree's branch.
    // Text in a Button doesn't truncate, so the branch is cut to the room left,
    // and a narrow pane cuts it before the markers.
    const rowMarks = (tree: TreeStatus, defaultBranch: string | null, used: number) => {
      const all = marks(tree, defaultBranch)
      const hasBranch = !tree.isPrunable && tree.error === null
      const branch = hasBranch ? all.pop() : undefined
      const drawn = all.map(mark => <Text color={mark.color} mono>{` ${mark.text}`}</Text>)
      if (!branch) return drawn
      if (!Select) return [...drawn, <Text color={branch.color} mono>{` ${branch.text}`}</Text>]
      if (picking?.path === tree.path) {
        const current = branch.text
        return [
          ...drawn,
          <Text> </Text>,
          <Select
            key={`pick:${tree.path}`}
            autoFocus
            value={current}
            options={[{ value: current, label: current }, ...picking.branches.map(name => ({ value: name, label: name }))]}
            onSelect={(value: string) => (value === current ? closePicker() : void switchTo(tree.path, value)())}
          />,
          <Text> </Text>,
          <Button plain key={`pick-close:${tree.path}`} label="✕" onPress={closePicker} />,
        ]
      }
      // A branch other than the main one, not merged yet, can be raised as a PR.
      const canRaise = tree.branch !== null && tree.branch !== defaultBranch && !merged.includes(tree.path)
      const pr = canRaise
        ? [<Text> </Text>, <Button plain dimColor key={`pr:${tree.path}`} label="PR" onPress={draftPullRequest(tree.path)} />]
        : []
      const room = e.props.bodyColumns - used - all.reduce((sum, mark) => sum + mark.text.length + 1, 0) - 1 - (canRaise ? 3 : 0)
      const fitted = branch.text.length > room ? `${branch.text.slice(0, Math.max(room - 1, 2))}…` : branch.text
      return [
        ...drawn,
        <Text> </Text>,
        <Button plain key={`branch:${tree.path}`} onPress={openPicker(tree.path)}>
          <Text color={branch.color} mono>
            {fitted}
          </Text>
        </Button>,
        ...pr,
      ]
    }

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
        isShown: repos.some(repo => repo.worktrees.some(tree => tree.isPrunable)),
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
        isShown: merged.some(path => !isHere(path)),
        hotkey: 'm',
        label: 'Remove merged',
        doing: 'Removing merged worktrees',
        work: async (s: Session) => removeAll(s, repos => mergedWorktrees(s, repos), 'merged', false),
      },
      {
        key: 'unreadable',
        isShown: repos.some(repo => repo.worktrees.some(tree => tree.error !== null && !isHere(tree.path))),
        hotkey: 'u',
        label: 'Remove unreadable',
        doing: 'Removing unreadable worktrees',
        work: async (s: Session) => removeAll(s, async repos => unreadableWorktrees(repos), 'unreadable', true),
      },
    ]

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap" columnGap="sm" rowGap="xs">
          {buttons.filter(button => button.isShown !== false).map(button => (
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
              <Text dimColor mono>
                {row.prefix}
              </Text>
              <Button plain key={`fold:${row.path}`} label={row.name} onPress={() => void toggle(row.path)}>
                <Text bold color="suggestion" mono>
                  {row.foldedRepos ? '▸ ' : '▾ '}
                  {row.name}
                </Text>
                {row.foldedRepos > 0 && <Text dimColor>{` ${plural(row.foldedRepos, 'repo')}`}</Text>}
              </Button>
            </Box>
          ) : (
            <Box>
              <Text dimColor mono>
                {row.prefix}
              </Text>
              <Text bold={row.kind === 'repo'} italic={row.kind === 'worktree'} mono>
                {row.name}
              </Text>
              {isRemovable(row) && [
                <Text> </Text>,
                <Button plain dimColor key={`remove:${row.path}`} label="✕" onPress={removeOne(row.path)} />,
              ]}
              {row.tree && rowMarks(row.tree, row.defaultBranch, row.prefix.length + row.name.length + (isRemovable(row) ? 2 : 0))}
            </Box>
          ),
        )}
      </Box>
    )
  })
}
