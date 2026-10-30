---
name: tower-diff
description: Show the user a diff in Tower, the Git GUI installed on this Mac, through its gittower command line. Use this whenever the user wants to see or review changes visually rather than as text in the chat — "show me the diff", "let me see what changed", "open the working copy", "show me that commit", "open this in Tower", "what did commit X touch", a file's history, or who last changed a line — and whenever they ask to look at local, uncommitted or staged changes before a commit. Prefer it over pasting a long git diff into the conversation unless they explicitly ask for the text.
---

# Show a diff in Tower

Tower is the user's Git GUI. Its command-line helper, `gittower`, opens a
repository in Tower at a chosen view and returns at once. It prints nothing:
the result is on screen in Tower, not in the shell. Use it to put a diff in
front of the user, then tell them what Tower is now showing. Do not follow up
with `git diff` output unless they ask for the text.

## The helper's path

Tower does not put `gittower` on this machine's PATH, so run it by its full
path inside the app bundle:

```bash
/Applications/Tower.app/Contents/Helpers/gittower <subcommand> ...
```

If `command -v gittower` ever succeeds, that works too; the bundle path is
the one that always works.

## Which view to open

Pick the view from what the user wants to see. `-C <path>` names the
repository; without it the current directory is used, and a path anywhere
inside a working tree resolves to its root. In a worktree session, pass
the worktree's own path so Tower shows that checkout, not the main one.

| They want to see | Command |
| --- | --- |
| Local changes: uncommitted, unstaged or staged work (the default meaning of "the diff") | `gittower working-copy -C <repo>` |
| One commit's changes | `gittower commit <rev> -C <repo>` (`HEAD`, `HEAD~2`, a hash, a tag) |
| The history of a file, or of a branch | `gittower history <file> -C <repo>` / `gittower history <ref> -C <repo>` |
| A file as of some revision | `gittower history <rev>:<file> -C <repo>` |
| Who changed each line | `gittower blame <file> -C <repo>` (or `<rev>:<file>`) |
| Just the repository, no particular view | `gittower open <repo>` |

`--new-window` (`-n`) or `--new-tab` keeps the user's current Tower window as
it is; by default the view replaces whatever that repository's window shows.
Use `--new-tab` when they are already looking at something in Tower that
they might want to come back to, such as a commit they asked about a moment
ago.

A name that is both a ref and a file (a branch called `docs`, a folder
called `docs`) is ambiguous to `history`: say which with git's terminator,
`-- docs` for the file or `docs --` for the ref.

## Examples

**"Show me the local diffs"** (the repository is at `~/chronometer-web`):

```bash
/Applications/Tower.app/Contents/Helpers/gittower working-copy -C ~/chronometer-web
```

Then: "Tower is showing the Working Copy for chronometer-web: the modified
files, with the diff of whichever you select."

**"What did that last commit change?"**

```bash
/Applications/Tower.app/Contents/Helpers/gittower commit HEAD -C ~/chronometer-web
```

**"Let me see how es-time.ts got here"**

```bash
/Applications/Tower.app/Contents/Helpers/gittower history src/astronomy/es-time.ts -C ~/chronometer-web
```

## What to say afterwards

One line naming the view and the repository, plus anything they need to
look for (a file to select, the commit's subject). If the working tree is
clean, say so before opening the Working Copy view, since an empty view
looks like a failure. The helper opens one repository per call; for
several, run it once each.
