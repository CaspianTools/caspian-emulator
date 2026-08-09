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
