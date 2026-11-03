# Security policy

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub instead: [open a security advisory](https://github.com/farridav/claude-code-recursive-git/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a week. Once a fix is released, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Fixes go into the latest release only.

## What the mod can reach

The mod runs inside Claude Code with the permissions its hooks module is given. It:

- lists folders below the folder Claude Code started in, and reads `.git` files there
- runs `git` in the repos it finds. Every command is read-only except `git fetch`, which runs only when you ask for it (`/repos-fetch` or the pane's Fetch all).
- adds text to Claude's context: repo paths, branch names, file names from `git status`, and commit subjects

It sends nothing over the network itself. `git fetch` talks to your repos' own remotes, never prompting for credentials.
