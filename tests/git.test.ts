import { describe, expect, test } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'

import type { Io } from '../hooks/git'
import {
  baseName,
  classifyGitFile,
  describeRepo,
  findRepos,
  fingerprints,
  formatChanges,
  formatTable,
  needsAttention,
  parseStatus,
  parseWorktreeList,
  relativePath,
  resolvePath,
  shortState,
  statusLine,
} from '../hooks/git'

const STATUS = [
  '# branch.oid 1234567890abcdef',
  '# branch.head feature/login',
  '# branch.upstream origin/feature/login',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 aaa bbb src/app.py',
  '1 A. N... 000000 100644 100644 000 ccc src/new file.py',
  '2 R. N... 100644 100644 100644 ddd eee R100 src/moved.py\tsrc/old.py',
  'u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.txt',
  '? notes.md',
  '',
].join('\n')

describe('git', () => {
  test('parseStatus reads branch, upstream distance and file counts', () => {
    const tree = parseStatus('/ws/api', STATUS)
    expect(tree.branch).toBe('feature/login')
    expect(tree.head).toBe('1234567')
    expect(tree.upstream).toBe('origin/feature/login')
    expect([tree.ahead, tree.behind]).toEqual([2, 1])
    expect([tree.staged, tree.unstaged, tree.untracked, tree.conflicted]).toEqual([2, 1, 1, 1])
    expect(tree.files).toEqual([' M src/app.py', 'A  src/new file.py', 'R  src/moved.py', 'UU conflict.txt', '?? notes.md'])
    expect(shortState(tree)).toBe('feature/login* ↑2 ↓1')
  })

  test('parseStatus handles a detached HEAD and a repo with no commits', () => {
    const detached = parseStatus('/ws/a', '# branch.oid abcdef1234\n# branch.head (detached)\n')
    expect(shortState(detached)).toBe('detached@abcdef1')
    const fresh = parseStatus('/ws/b', '# branch.oid (initial)\n# branch.head main\n')
    expect(fresh.head).toBe(null)
    expect(shortState(fresh)).toBe('main')
  })

  test('parseWorktreeList reads main, linked, bare and prunable worktrees', () => {
    const list = parseWorktreeList(
      [
        'worktree /ws/api',
        'HEAD abc',
        'branch refs/heads/main',
        '',
        'worktree /ws/api/.claude/worktrees/fix',
        'HEAD def',
        'branch refs/heads/fix',
        '',
        'worktree /tmp/gone',
        'HEAD 123',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    )
    expect(list.map(entry => entry.path)).toEqual(['/ws/api', '/ws/api/.claude/worktrees/fix', '/tmp/gone'])
    expect(list.map(entry => entry.isPrunable)).toEqual([false, false, true])
  })

  test('classifyGitFile tells linked worktrees from submodules', () => {
    expect(classifyGitFile('/ws/api-fix', 'gitdir: /ws/api/.git/worktrees/api-fix\n')).toEqual({
      kind: 'worktree',
      mainRepo: '/ws/api',
    })
    expect(classifyGitFile('/ws/api/wt', 'gitdir: ../.git/worktrees/wt\n')).toEqual({ kind: 'worktree', mainRepo: '/ws/api' })
    expect(classifyGitFile('/ws/api/libs/ui', 'gitdir: ../../.git/modules/libs/ui\n')).toEqual({ kind: 'skip' })
    expect(classifyGitFile('/ws/wt', 'gitdir: /srv/repo.git/worktrees/wt')).toEqual({ kind: 'worktree', mainRepo: '/ws/wt' })
  })

  test('paths resolve and relativise', () => {
    expect(resolvePath('/ws/a/b', '../../c/./d')).toBe('/ws/c/d')
    expect(relativePath('/ws', '/ws/services/api')).toBe('services/api')
    expect(relativePath('/ws', '/elsewhere/api')).toBe('../elsewhere/api')
    expect(baseName('/home/me/.cursor/worktrees/api/xjp')).toBe('xjp')
  })

  /** An in-memory file tree: a path ending in `/` is a folder, `.git/` a repo. */
  function fakeIo(paths: string[], files: Record<string, string> = {}): Io {
    const entries = new Map<string, FsEntry[]>()
    const add = (dir: string, entry: FsEntry) => {
      const list = entries.get(dir) ?? []
      if (!list.some(one => one.name === entry.name)) list.push(entry)
      entries.set(dir, list)
    }
    for (const path of [...paths, ...Object.keys(files)]) {
      const parts = path.split('/').filter(Boolean)
      const isDir = path.endsWith('/')
      parts.forEach((name, index) => {
        const dir = '/' + parts.slice(0, index).join('/')
        const isLast = index === parts.length - 1
        add(dir === '/' ? '/' : dir, { name, kind: isLast && !isDir ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false })
      })
    }
    return {
      list: async path => entries.get(path) ?? [],
      readFile: async path => files[path] ?? '',
      run: async () => ({ exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
    }
  }

  test('findRepos stops at repos, skips dependency folders and keeps to the depth', async () => {
    const io = fakeIo(
      [
        '/ws/api/.git/',
        '/ws/api/node_modules/dep/.git/', // inside a repo: never reached
        '/ws/web/.git/',
        '/ws/group/infra/.git/',
        '/ws/group/.terraform/modules/vpc/.git/', // dot-folder
        '/ws/_archive/old/.git/', // parked work
        '/ws/tools/node_modules/pkg/.git/', // ignored name
        '/ws/a/b/c/four/.git/', // depth 4
        '/ws/a/b/c/d/five/.git/', // depth 5
        '/ws/web/libs/ui/', // submodule below a repo: never reached
      ],
      {
        '/ws/api-hotfix/.git': 'gitdir: /ws/api/.git/worktrees/api-hotfix\n',
        '/ws/vendored/sub/.git': 'gitdir: /ws/vendored/.git-modules/modules/sub\n',
      },
    )
    const ignore = new Set(['node_modules'])
    expect(await findRepos(io, '/ws', 4, ignore)).toEqual(['/ws/a/b/c/four', '/ws/api', '/ws/group/infra', '/ws/web'])
    expect(await findRepos(io, '/ws', 5, ignore)).toContain('/ws/a/b/c/d/five')
  })

  test('findRepos stays out of the way when the root is itself a repo', async () => {
    const io = fakeIo(['/ws/.git/', '/ws/sub/.git/'])
    expect(await findRepos(io, '/ws', 4, new Set())).toEqual([])
  })

  test('formatChanges reports only the trees that changed', () => {
    const clean = parseStatus('/ws/api', '# branch.oid aaaaaaa\n# branch.head main\n')
    const repo = { name: 'api', path: '/ws/api', defaultBranch: 'main', recent: [], tree: clean, worktrees: [] }
    const other = { ...repo, name: 'web', path: '/ws/web', tree: { ...clean, path: '/ws/web' } }
    const before = fingerprints([repo, other])
    expect(formatChanges(before, [repo, other])).toEqual([])

    const dirty = parseStatus('/ws/api', '# branch.oid aaaaaaa\n# branch.head main\n? todo.txt\n')
    expect(formatChanges(before, [{ ...repo, tree: dirty }, other])).toEqual([
      '- api: main*, 1 untracked (?? todo.txt)',
    ])
    expect(formatChanges(before, [repo])).toEqual(['- /ws/web: no longer present'])
  })

  test('worktrees go by their folder name, and an unreadable one by a short state', () => {
    const clean = parseStatus('/ws/api', '# branch.oid aaaaaaa\n# branch.head main\n')
    const broken = { ...parseStatus('/elsewhere/xjp', ''), error: 'fatal: not a git repository: /old/.git/worktrees/xjp' }
    const fix = parseStatus('/ws/api/.worktrees/api--fix', '# branch.oid bbbbbbb\n# branch.head fix\n')
    const repo = { name: 'api', path: '/ws/api', defaultBranch: 'main', recent: [], tree: clean, worktrees: [fix, broken] }

    const [, fixRow, brokenRow] = formatTable([repo]).split('\n')
    expect(fixRow).toMatch(/^  └ api--fix +fix +clean$/)
    expect(brokenRow).toMatch(/^  └ xjp +unreadable$/)
    expect(describeRepo(repo)).toContain('Error: fatal: not a git repository: /old/.git/worktrees/xjp')
  })

  test('the band skips repos that are only behind; the status line counts in words', () => {
    const behind = parseStatus('/ws/api', '# branch.oid aaaaaaa\n# branch.head main\n# branch.ab +0 -3\n')
    const ahead = parseStatus('/ws/web', '# branch.oid aaaaaaa\n# branch.head main\n# branch.ab +1 -0\n')
    const api = { name: 'api', path: '/ws/api', defaultBranch: 'main', recent: [], tree: behind, worktrees: [] }
    const web = { ...api, name: 'web', path: '/ws/web', tree: ahead }
    expect(needsAttention(api)).toBe(false)
    expect(needsAttention(web)).toBe(true)

    expect(statusLine([api], '/ws')).toBe('⎇ 1 repo')
    expect(statusLine([api, { ...web, worktrees: [behind] }], '/ws')).toBe('⎇ 2 repos · 1 worktree · 1 ahead')
  })
})
