// Scans a scratch workspace of real git repos with hooks/git.ts, the way the
// mod does in a session, and checks what it finds. The tests in tests/ fake
// git; this runs the real thing, so parsing is checked against real output.
//
//   node --experimental-strip-types scripts/smoke.ts

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_IGNORE, formatTable, scanAll } from '../hooks/git.ts'
import type { Io } from '../hooks/git.ts'

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.com',
  GIT_COMMITTER_NAME: 'smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.com',
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_IDENTITY }, stdio: 'pipe' })
}

function makeRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'commit', '-q', '--allow-empty', '-m', `init ${path}`)
}

/** Builds the workspace every check below is about. */
function buildWorkspace(root: string): void {
  makeRepo(join(root, 'clean'))
  git(join(root, 'clean'), 'worktree', 'add', '-q', '../clean-feature', '-b', 'feature')

  makeRepo(join(root, 'dirty'))
  writeFileSync(join(root, 'dirty', 'new.txt'), 'x\n')

  makeRepo(join(root, 'lib'))
  git(join(root, 'dirty'), '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', join(root, 'lib'), 'libs/lib')
  makeRepo(join(root, 'dirty', 'node_modules', 'dep')) // inside a repo: never reached

  makeRepo(join(root, 'tools', 'node_modules', 'pkg')) // an ignored folder name
  makeRepo(join(root, 'infra', '.terraform', 'modules', 'vpc')) // a dot-folder
  makeRepo(join(root, 'group', 'a', 'b', 'four')) // depth 4: found
  makeRepo(join(root, 'group', 'a', 'b', 'c', 'five')) // depth 5: past the default
}

const io: Io = {
  list: async path =>
    readdirSync(path, { withFileTypes: true }).map(entry => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
      size: 0,
      mtimeMs: 0,
      isLink: entry.isSymbolicLink(),
    })),
  readFile: async path => readFileSync(path, 'utf8'),
  run: async (argv, init) => {
    try {
      const stdout = execFileSync(argv[0] ?? 'git', argv.slice(1), {
        env: { ...process.env, ...init?.env },
        stdio: 'pipe',
        encoding: 'utf8',
      })
      return { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string }
      return {
        exitCode: failed.status ?? 1,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      }
    }
  },
}

function check(isTrue: boolean, what: string): void {
  console.log(`${isTrue ? 'ok  ' : 'FAIL'} ${what}`)
  if (!isTrue) process.exitCode = 1
}

const root = mkdtempSync(join(tmpdir(), 'multi-repo-smoke-'))
try {
  buildWorkspace(root)
  const ignore = new Set(DEFAULT_IGNORE)
  const repos = await scanAll(io, root, 4, ignore)
  console.log(formatTable(root, repos) + '\n')

  const names = repos.map(repo => repo.name)
  check(JSON.stringify(names) === JSON.stringify(['clean', 'dirty', 'group/a/b/four', 'lib']), `finds the four repos: ${names.join(', ')}`)

  const clean = repos.find(repo => repo.name === 'clean')
  check(clean?.worktrees.length === 1 && clean.worktrees[0]?.branch === 'feature', 'lists the linked worktree under its repo')
  check(!names.includes('clean-feature'), 'does not list the worktree as a repo of its own')
  check(!names.some(name => name.includes('libs')), 'leaves the submodule to its parent')
  check(!names.some(name => name.includes('node_modules') || name.includes('.terraform')), 'skips dependency checkouts')

  const dirty = repos.find(repo => repo.name === 'dirty')
  check(dirty?.tree.branch === 'main' && dirty.tree.untracked > 0 && dirty.tree.staged > 0, 'reads branch and changes')
  check(dirty?.defaultBranch === 'main', 'names the main branch')

  const deeper = await scanAll(io, root, 5, ignore)
  check(deeper.some(repo => repo.name === 'group/a/b/c/five'), 'a deeper scanDepth finds the depth-5 repo')
} finally {
  rmSync(root, { recursive: true, force: true })
}
