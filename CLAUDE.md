# Caspian Emulator — Claude Code Instructions

## Global Rules

- **Do NOT include `Co-Authored-By` lines in commit messages.** Never add co-author trailers for Claude or any AI assistant.
- **Every commit MUST increment the version** in `package.json`, add a `CHANGELOG.md` entry, and update `readme.md` to reflect the current version and feature set. No exceptions.

## Project Overview

VS Code extension for Android emulator management. TypeScript + esbuild, targeting VS Code ^1.85.0.

### Architecture

```
src/
├── extension.ts              — Entry point, command registration, activation
├── constants.ts              — Command IDs, view IDs, config keys
├── types.ts                  — TypeScript interfaces
├── sdk/SdkManager.ts         — SDK auto-detection, validation, setup wizard
├── sdk/SdkDownloader.ts      — Zero-dependency SDK download and installation
├── adb/AdbClient.ts          — ADB command wrapper
├── adb/DeviceTracker.ts      — Real-time device connection monitoring
├── avd/AvdManager.ts         — AVD CRUD, emulator launch/stop
├── views/AvdTreeProvider.ts  — Sidebar: Virtual Devices
├── views/DeviceTreeProvider.ts — Sidebar: Connected Devices
├── views/FileExplorerProvider.ts — Sidebar: Device file browser
├── views/LogcatPanel.ts      — Webview: live logcat viewer
└── views/EmulatorScreenPanel.ts — Webview: emulator screen mirror
```

### Key Patterns

- All ADB/emulator interactions go through `AdbClient` or `AvdManager` — never call `child_process` directly from views or commands.
- Tree views use the `TreeDataProvider` pattern with `_onDidChangeTreeData` event emitters.
- Webview panels (logcat, emulator screen) communicate with the extension via `postMessage`/`onDidReceiveMessage`.
- Commands are registered via the `reg()` helper in `registerCommands()` inside `extension.ts`.
- New commands must be added to both `constants.ts` (`COMMANDS`) and `package.json` (`contributes.commands` + menus).

## Owner actions live in GitHub issues, linked to the session that asked

**Rule (owner, 20 Nov 2026).** Anything the owner has to do, decide or check
is a GitHub issue **in this repository**, opened in the same turn it comes
up — never only in the chat. The chat disappears when the session ends; the
issue does not. Link the issue in the reply. Search the open issues first and
add to an existing one rather than opening a duplicate.

### Mark who it is for, twice

| For | Label | Title starts with |
| --- | --- | --- |
| The owner — something to do or check | `for: owner` | `[YOU]` |
| The owner — a choice to make | `for: owner` + `decision` | `[YOU · DECIDE]` |
| Claude — development work to pick up | `for: claude` | `[CLAUDE]` |

Create the labels if the repository does not have them yet. When an issue
changes hands, change both markers.

### The shape of a `[YOU]` issue: steps first, reasons last

```
## Do this

1. One action, naming the site, repository or console it happens in.
   A command, or a Claude for Chrome script for anything done in a
   browser, goes in its own block under the step.

2. Next action.

## Why

Two sentences at most: what is wrong and what doing the steps changes.

**Urgency:** one word, with a half-sentence if it needs one.

## Sessions

**Changed by:** https://claude.ai/code/session_… (pull request owner/repo#N)

**Asked by:** https://claude.ai/code/session_… (go back here with the result)

<details>
<summary>Background</summary>

- Everything else: how it was found, what Claude could not do and why,
  the exact names of projects, services and settings involved.

</details>
```

- **Steps are the issue**: one imperative action each, a blank line between
  every block, under about 120 words above `<details>`. Explanation goes
  inside `<details>`, collapsed. One issue, one thing to do.
- **The owner is not a developer.** Write in plain words what happens to
  the business, the site or the customer; literal text only in a command.
- `[YOU · DECIDE]` uses the same frame with `## Decide` (the options as a
  numbered list, the recommendation marked) in place of `## Do this`.
- **Anything in a browser is a Claude for Chrome script** inside the step,
  never a list of clicks: numbered steps, one action each, the address in
  every step that navigates, the exact on-screen words to expect, stop at
  the first step that misbehaves, nothing it must not touch, and a check of
  the deploy first when the step depends on one. It ends: "Give me step,
  pass or fail, and the exact wording of anything that failed. If every
  step passed, comment the results on <issue link> and close it; otherwise
  comment the failing step and leave it open. End the comment with: Report
  this back to <Asked by session link>."
- **A changed script is a new comment**, never an edit: headed
  `Updated script (<date>) — use this one`, holding the whole script. A
  "run it again" is a new comment too.
- **Commands for the owner** run on Windows in PowerShell and Command
  Prompt alike: full paths, no shell variables, no `&&`, no pipes.

### Link the session that asked

An issue alone does not say which conversation wants the answer, so every
one carries the session's link, and the owner can go back to that session
and report what was done.

- **Where the link comes from:** the `Claude-Session:` line of the commit
  attribution (`https://claude.ai/code/session_…`); if it is missing,
  `get_session` with no id gives the session id.
- **Every `[YOU]` and `[YOU · DECIDE]` issue has the `## Sessions` section**:
  **Changed by** (the session that made the change being checked, with its
  pull request) and **Asked by** (the session waiting for the result). When
  they are the same, one line: `**Session:** <link> (made the change and is
  waiting for the result)`.
- **Every comment that asks the owner to run a script** starts with
  `**Asked by:** <link>`; the newest comment's session is the one to go back
  to. A `[CLAUDE]` issue names the session that opened it the same way.
- A session that finds a result on an issue acts on it there, even when
  another session asked: the link is for the owner, not a lock.

### Close what is finished

Close an issue once the evidence is in (the owner's report, a script's
comment, output they pasted), with a one-line comment saying what proves
it; `not planned` when nothing was done. Never close on an assumption.
End every issue and comment with the Claude Code attribution footer.

## Pre-Commit Checklist

Before every `git commit`, follow these steps **in order**. Do not skip any step. If a step fails, fix the issue and re-run from that step before continuing.

### 1. Lint
```
npm run lint
```
Fix all linting errors. Never use `--no-verify` to bypass lint failures.

### 2. Type Check & Build
```
npm run typecheck
npm run build
```
Fix all TypeScript compilation errors before proceeding.

### 3. Review Changed Files
Review all staged and modified files for:
- Accidental debug code (`console.log`, `debugger`, leftover `TODO`/`FIXME` comments)
- Hardcoded secrets, credentials, or API keys
- Unused imports or dead code introduced by the changes

If any issues are found, fix them before proceeding.

### 4. Bump Version (MANDATORY — never skip)
Increment the version number for **every** commit:

0. **Check the Marketplace floor first.** The new version must be greater than the version **currently published on the Marketplace**, not merely greater than local `package.json`. The two can drift apart if anything is ever published out-of-band, and the Marketplace rejects any upload at or below its published version. (This already happened once: a `1.0.0` was published on 2026-07-03 that never existed in git, stranding the repo's `0.6.x` line below it.) Query the live version with:
   ```powershell
   $body = @{ filters=@(@{ criteria=@(@{ filterType=7; value="CaspianTools.caspian-emulator" }) }); flags=914 } | ConvertTo-Json -Depth 6
   (Invoke-RestMethod -Uri "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.1-preview.1" `
     -Method Post -ContentType "application/json" -Headers @{Accept="application/json;api-version=7.1-preview.1"} `
     -Body $body).results[0].extensions[0].versions[0].version
   ```
1. **`package.json`** — bump the `version` field (patch by default; minor for new features, major for breaking changes).
2. **`CHANGELOG.md`** — add a new `## [X.Y.Z] - YYYY-MM-DD` heading above the previous version.
3. **`readme.md`** — update any version references (e.g., install commands like `code --install-extension caspian-emulator-X.Y.Z.vsix`).
4. Run `npm install` to sync `package-lock.json` with the new version.

### 5. Update Documentation (MANDATORY — never skip)
Update **all** documentation affected by the changes. Review each file below and update it if the changes affect its content:

| File | What it covers | When to update |
|------|---------------|----------------|
| `CHANGELOG.md` | Version history | **Always** — add entries under current version (`### Added`/`### Changed`/`### Fixed`) |
| `readme.md` | VS Code Marketplace listing | **Always** — must reflect current features, commands, settings, version |
| `package.json` `description` | One-line extension summary | When capabilities change |
| `QUICKSTART.md` | 2-minute getting started guide | When setup flow, prerequisites, or basic usage changes |
| `SETUP_GUIDE.md` | SDK setup, settings, screen mirroring, troubleshooting | When configuration, setup options, or troubleshooting steps change |
| `ARCHITECTURE.md` | System design, module descriptions, data flows | When adding/removing/renaming modules, changing data flows |
| `BUILD.md` | Dev setup, build commands, project structure | When build process, dependencies, or dev workflow changes |
| `START_HERE.md` | Documentation index | When adding or renaming documentation files |

**Do NOT update the GitHub Wiki.** The wiki is no longer maintained — feature announcements go to GitHub Discussions instead (step 11).

### 6. Build & Package VSIX
```
npx @vscode/vsce package --allow-missing-repository
```
Confirm the extension packages into a `.vsix` without errors. **Always produce a fresh `.vsix` after every task** so it is ready for immediate marketplace submission. The `.vsix` is gitignored (`*.vsix`) and will not be committed.

### 7. Commit
Create the commit with a descriptive message in imperative mood, matching the project's established style (e.g., "Add logcat tag filtering" not "Added logcat tag filtering"). Do **not** include `Co-Authored-By` trailers.

### 8. Tag
Create an annotated git tag for the new version:
```bash
git tag -a vX.Y.Z -m "vX.Y.Z — <short summary>"
```

### 9. Push
Push the commit and tag to the remote:
```bash
git push origin main --tags
```

### 10. Create GitHub Release
Create a GitHub Release with the `.vsix` attached:
```bash
gh release create vX.Y.Z caspian-emulator-X.Y.Z.vsix \
  --title "vX.Y.Z — <short summary>" \
  --notes "<changelog entries for this version>"
```

### 11. Post to GitHub Discussions
After every commit, create a GitHub Discussion in the **Announcements** category. The post must be **social-media-ready** — the user should be able to copy-paste it directly to Twitter/X, LinkedIn, etc.

**Format requirements:**
- **Title:** action-oriented, attention-grabbing, under 100 characters (e.g., "Caspian Emulator now mirrors your screen inside VS Code")
- **Body:** 2-4 bullet points of what's new, a one-liner value prop, and the VS Code Marketplace link. Use emojis sparingly for visual appeal.
- **Always include the Marketplace link:** https://marketplace.visualstudio.com/items?itemName=CaspianTools.caspian-emulator
- Keep it short and punchy — 1-3 sentences for the intro, then bullets.

**Create via GraphQL API:**
```bash
gh api graphql -f query='
  mutation {
    createDiscussion(input: {
      repositoryId: "R_kgDORYfDVA",
      categoryId: "DIC_kwDORYfDVM4C3LGW",
      title: "<TITLE>",
      body: "<BODY>"
    }) {
      discussion { url }
    }
  }
'
```

**Example post:**
> **Title:** Caspian Emulator 0.2.0 — Full logcat viewer with live filtering
>
> **Body:**
> Caspian Emulator 0.2.0 is here — debug your Android apps without leaving VS Code.
>
> - Live logcat streaming with priority filtering and tag search
> - Embedded emulator screen mirror with touch input
> - One-click APK install, screenshot, and screen recording
> - Browse and manage device files from the sidebar
>
> https://marketplace.visualstudio.com/items?itemName=CaspianTools.caspian-emulator

## Worktrees & the ship rule

Claude Code can run parallel sessions in isolated **git worktrees** (`claude --worktree <name>`, or ask it to "work in a worktree" → the `EnterWorktree` tool). A worktree lives under `.claude/worktrees/<name>/` on branch `worktree-<name>`, branched **fresh from `origin/main`** by default (set `worktree.baseRef: "head"` in `.claude/settings.json` to carry local HEAD instead). `.claude/worktrees/` is gitignored and **`.worktreeinclude`** copies any local secrets/env files into new worktrees — see those two files. `node_modules` is *not* copied: run `npm install` in each new worktree, then `npm run build`.

**The catch:** this repo has **no CI — nothing ships on push.** Going live is a deliberate, manual sequence (see the Pre-Commit Checklist above): `git push origin main --tags` → `gh release create vX.Y.Z caspian-emulator-X.Y.Z.vsix …` → then the Marketplace submission of that `.vsix`. A worktree sits on `worktree-<name>`, so a plain "commit + push" *inside* a worktree pushes a **feature branch**, not `main` — it publishes nothing and produces no release. So the standing "finish the task, then commit + push" flow **adapts inside a worktree** — do NOT blindly push a worktree branch and assume it's shipped:

1. **Commit, pause before landing.** Auto-commit finished work on the `worktree-<name>` branch, then **stop and report**. Never merge to `main` / push `main` (and never cut the tag, GitHub Release, or Marketplace upload) without the owner's explicit go-ahead. *(On `main` — the normal solo flow — the checklist is unchanged: bump version, lint/typecheck/build, package, commit, tag, push, release, announce.)*
2. **Serialize landings — one at a time.** Never land two worktrees to `main` in parallel. If another worktree/session is still in flight, wait for it to land first. There's no live cross-session signal, so "wait" means: at land time `git fetch` and rebase onto whatever `origin/main` now is; if the owner says another is mid-flight, hold until told it's done.
3. **Resolve conflicts in the worktree, never on `main`.** At land time: `git fetch origin` → **rebase `worktree-<name>` onto the latest `origin/main`** → resolve every conflict *there*, so `main` only ever receives an already-merged, clean tree.
4. **Finalize the version bump last.** The version is the *guaranteed* collision between two shippable worktrees — this repo requires **every** commit to bump `package.json` `version`, add a `CHANGELOG.md` entry, update version references in `readme.md`, and `npm install` to sync `package-lock.json`. Don't fix the number until after the rebase — take *current-main + 1* (patch/minor/major as fits the change), then update those files and the `vX.Y.Z` tag name to match.
5. **Re-verify + rebuild after resolving.** Re-run the checklist gates: `npm run lint`, `npm run typecheck`, `npm run build`, and repackage with `npx @vscode/vsce package --allow-missing-repository` so a fresh `.vsix` matches the final tree. A conflict resolution that isn't re-verified is a bug waiting to ship.
6. **Only then ship.** Fast-forward `main` to the clean, verified branch → `git push origin main --tags` → `gh release create vX.Y.Z caspian-emulator-X.Y.Z.vsix …`, then submit the `.vsix` to the Marketplace and post the Announcements Discussion (checklist steps 10–11). **Never push a conflicted or failing tree to `main`, and never release a `.vsix` built from an unverified tree.**

For solo, single-stream work that ships immediately, **skip worktrees and work on `main` directly** — the Pre-Commit Checklist needs no adaptation. Reserve worktrees for genuine parallelism (two tasks at once) or experiments you may not ship.
