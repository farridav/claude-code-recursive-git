import { expect, mock, test } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

const TREE: Record<string, FsEntry[]> = {
  '/ws': [dir('api'), dir('web'), dir('node_modules')],
  '/ws/api': [dir('.git'), dir('src')],
  '/ws/web': [dir('.git')],
  '/ws/node_modules': [dir('dep')],
  '/ws/node_modules/dep': [dir('.git')],
}

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** Stands in for the engine: the file tree above and a git whose status `dirty` changes. */
function workspace(on: On, state: { dirty: boolean }) {
  const clock = mock.clock(on)
  on('session.root', () => ({ value: '/ws' }))
  on('session.cwd', () => ({ value: '/ws' }))
  on('fs.list', (_, e) => ({ value: TREE[e.path] ?? [] }))
  on('fs.read', () => ({ value: '' }))
  on('process.run', (_, e) => {
    const [, , path, command] = e.argv
    if (command === 'status') {
      const untracked = path === '/ws/api' && state.dirty ? '? todo.txt\n' : ''
      return { value: ok(`# branch.oid abcdef1234\n# branch.head main\n${untracked}`) }
    }
    if (command === 'worktree') {
      const linked = path === '/ws/api' ? 'worktree /ws/.wt/api-fix\nHEAD 1\nbranch refs/heads/fix\n\n' : ''
      return { value: ok(`worktree ${path}\nHEAD 1\nbranch refs/heads/main\n\n${linked}`) }
    }
    if (command === 'log') return { value: ok('abcdef1 Initial commit\n') }
    if (command === 'symbolic-ref') return { value: ok('origin/main\n') }
    return { value: ok('') }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__multi-repo__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return clock
}

const BAND = {
  plugin: 'multi-repo',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const TYPED = { wait: false, origin: { kind: 'composer' } } as const

// The tool is typed only in sessions where the mod has registered it, so its input is cast.
const repoStatus = (args: Record<string, unknown> = {}) => ({ tool: 'mcp__multi-repo__repo_status', ...args }) as never

const PANE = {
  plugin: 'multi-repo',
  component: 'Pane',
  requestId: 'multi-repo',
  props: { title: 'Repos', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('finds the repos and their worktrees, and leaves dependencies out', async ($, on) => {
  workspace(on, { dirty: true })
  await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call(repoStatus())
  expect(ran.result).toContain('## api')
  expect(ran.result).toContain('## web')
  expect(ran.result).toContain('/ws/.wt/api-fix')
  expect(ran.result).toContain('Main branch (you will usually use this for PRs): main')
  expect(String(ran.result)).not.toContain('node_modules')

  const one = await $.tool.call(repoStatus({ repo: './web' }))
  expect(String(one.result)).not.toContain('## api')
})

test('the band shows dirty repos and the pane lists every repo with its worktrees', async ($, on) => {
  workspace(on, { dirty: true })
  await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /api/ }))?.text).toContain('api main* +1wt')
    expect(await band.find({ type: 'Text', text: /web/ })).toBeUndefined()
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /web/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /api-fix/ })).toBeDefined()
    expect(await pane.find({ key: 'refresh' })).toBeDefined()
    await pane.unmount()
  }
})

test('the first context carries a snapshot; later prompts carry only what changed', async ($, on) => {
  const state = { dirty: false }
  const clock = workspace(on, state)
  on('prompt.context', (_, e) => ({ blocks: e.blocks }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })

  const context = await $.prompt.context({ blocks: [] })
  const block = context.blocks.find(one => one.name === 'multiRepoStatus')
  expect(block?.text).toContain('## api')

  const quiet = await $.prompt.submit({ text: 'hello', ...TYPED })
  expect(quiet.context ?? []).toEqual([])

  state.dirty = true
  await clock.advance(11_000)
  const changed = await $.prompt.submit({ text: 'next', ...TYPED })
  expect(changed.context?.[0]).toContain('- api: main*, 1 untracked (?? todo.txt)')
  expect(changed.context?.[0]).not.toContain('web')
})
