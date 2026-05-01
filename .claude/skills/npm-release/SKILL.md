---
name: npm-release
description: End-to-end release workflow for publishing a Node/TypeScript package to npm — commits pending changes, pushes, bumps version, runs prepublish lint and dry-run checks, then hands off to the user to run `npm publish` manually. Use this skill whenever the user asks to "publish", "release", "ship", "push to npm", "publish to npmjs", "cut a release", "tag a version", or any combination of "commit + push + publish". Trigger even when the user only mentions one stage (e.g. "just publish it") — the skill decides which stages to skip based on repo state. Also trigger when the user is about to run `npm publish` for the first time and would benefit from pre-flight checks.
---

# npm-release

End-to-end "ship a package to npm" workflow. The default scope is the full chain — commit pending work → push → version bump → prepare for publish → push tag — but every stage is skippable based on repo state. The point is to **catch the boring footguns before they hit the registry**, because every published version number is permanent (you cannot reuse `1.2.3` even after `npm unpublish`).

**You do not run `npm publish` yourself.** The actual publish step is always handed off to the user to run manually. This is intentional: 2FA prompts, OTP entry, and credential confirmation belong with the human. Your job is to do all the prep so that when the user runs `npm publish`, it just works.

## When to use

- The user wants to publish a package (any phrasing: "ship it", "release", "publish to npm", "cut 0.2.0").
- The user is about to run `npm publish` manually and would benefit from pre-flight checks.
- The user mentions a release-adjacent action that implies the full chain (e.g. "tag and release").

If only one stage is needed (e.g. "just bump the version"), still load this skill — the relevant section gives the right command. Don't refuse to engage just because the user only wants part of the workflow.

## The mental model

A release has four destinations, and each is a different kind of permanent:

| Destination | Permanence | Reversible? |
|-------------|------------|-------------|
| Local commit | trivial | yes (`git reset`) |
| Remote branch | visible to teammates/CI | hard (`push --force`, breaks others) |
| Git tag (pushed) | semi-permanent | hard (delete + re-push) |
| npm registry | **permanent** | **no** (version number is burned forever) |

So the order matters: do everything reversible first, verify hard, then publish last. If you publish first and then realize the README still says `npm i old-name`, the only fix is a new version.

## The workflow

Walk through these stages in order. Each stage has a "skip if" condition.

### Stage 0 — Establish state

Before touching anything, run these in parallel and read the output:

```bash
git status --short
git log --oneline -5
git rev-parse --abbrev-ref HEAD
npm whoami           # confirms login; errors if not logged in
node --version
```

What you're checking:
- Working tree clean or has uncommitted changes? (drives Stage 1)
- Are we on `main` / `master`, or a branch? (releasing from a feature branch is usually wrong — flag it)
- Is the user logged in to npm? (no point continuing if not — direct them to `npm login --auth-type=web`)
- Does Node satisfy `engines.node` in `package.json`? (otherwise local builds may not match what users will get)

**Skip if:** never. Always do this.

### Stage 1 — Commit pending changes

If `git status` showed modifications, commit them before publishing. The reason: the npm tarball will contain the *current working tree* (after `prepublishOnly` builds), which means uncommitted source changes ship to users without ever being in git. That's how "the published version doesn't match any commit" bugs happen.

Show the user the diff (`git diff`) and propose a commit message based on what changed. Don't bundle unrelated changes into one release commit — if the user has half-finished work mixed with the release prep, ask them what should go in.

**Skip if:** working tree is clean.

### Stage 2 — Pre-publish sanity checks

These all run *before* the version bump because if any fail, you want to fix them on the current version, not a new one.

#### 2a. Lint `package.json`

```bash
npm pkg fix
git diff package.json
```

`npm pkg fix` silently auto-corrects things npm would otherwise warn about during publish. Common corrections:
- `bin.<name>` value `"./bin/foo"` → `"bin/foo"` (no leading `./`)
- `repository.url` `"https://..."` → `"git+https://..."`
- Removing trailing slashes, normalizing license SPDX, etc.

If `npm pkg fix` made changes, commit them now (small commit, e.g. `chore: normalize package.json`). Reason: you want the source-of-truth `package.json` to match what gets published. Otherwise every future `npm publish` re-emits the same warnings.

#### 2b. Build and smoke-test

```bash
npm run build         # if a build script exists
node <bin-path> --help
```

The smoke test catches the worst class of release bug: shipping a tarball whose binary doesn't actually run. The bin path is in `package.json` under `bin.<name>` — read it from there rather than guessing. If `--help` isn't supported, try `--version` or whatever the binary's no-op invocation is.

#### 2c. Dry-run pack

```bash
npm pack --dry-run 2>&1 | tail -50
```

This shows the exact file list that will end up in the tarball. **Read it carefully.** Things to flag:
- Is anything sensitive in there? `.env`, `.env.local`, private keys, internal docs?
- Is `node_modules` in there? (means `files` field is missing or wrong)
- Is the source TypeScript in there alongside the compiled JS? (usually unintended — bloats install size)
- Are the documented files all present? README, LICENSE, CHANGELOG, the bin, the dist?
- Total size sane? Most CLIs are <100 kB; if you're seeing 50 MB, something's wrong.

If any of these look off, fix `package.json` `files` (allowlist) or `.npmignore` (denylist) before continuing. Prefer `files` — it's safer because new files don't accidentally leak.

#### 2d. Name availability (only if first publish)

```bash
npm view <name>
```

A 404 means the name is free. A successful response means someone owns it — either you (in which case proceed) or someone else (in which case you need to scope or rename).

**npm also rejects names too similar to existing packages** at publish time, with no warning until you try. If `npm publish` later fails with "Package name too similar to existing packages X,Y; try renaming...", scope under an org or user:
- Update `name` in `package.json` to `@<scope>/<name>`
- **Sweep the install instructions** — README, landing pages, docs, any `npm install -g <oldname>` references. The scope changes the install command, and stale install commands are a major source of "it doesn't work" support tickets.
- Publish requires `--access=public` for scoped packages (see Stage 4).

**Skip if:** package has been published before (subsequent versions don't re-check the name).

### Stage 3 — Version bump

```bash
npm version <patch|minor|major>
```

This single command does three things: writes the new version into `package.json`, creates a commit, and creates an annotated git tag (e.g. `v0.2.0`). If the working tree wasn't clean it would refuse — that's why Stage 1 came first.

How to pick the bump (semver):
- **patch** — bug fixes, no behavior change for callers
- **minor** — new features, backwards-compatible
- **major** — breaking changes (remove a flag, rename a command, change exit codes)
- **0.x.y** — for pre-1.0 packages, the rules are loose; people commonly treat `0.x` minors as breaking. State your interpretation in the README so users know.

For pre-releases (e.g. release candidates), use `npm version prerelease --preid=rc` and publish with `--tag next` so it doesn't become the default install (Stage 4).

**Skip if:** the user is republishing a version they already own (rare — usually a re-publish after `npm unpublish`, which has a 72-hour window). In that case, no version bump.

### Stage 4 — Push commits and tags

```bash
git push --follow-tags
```

`--follow-tags` pushes annotated tags reachable from the pushed commits — exactly what `npm version` creates. Don't use `git push --tags` (pushes *all* local tags, including unrelated experiments).

If the branch hasn't been pushed before, `git push -u origin <branch> --follow-tags`.

Pushing the tag *before* the publish is fine and preferred here: if the user's `npm publish` fails for a fixable reason (OTP typo, transient registry error), they can just retry — the tag/commit don't need to be redone. The only case where you'd push *after* publish is if you wanted to avoid an orphan tag in the (rare) case the publish is abandoned entirely; for almost all real releases the orphan-tag risk is fine.

**Skip if:** the user explicitly says they want to publish without pushing (rare — usually a sign something's wrong). Flag it.

### Stage 5 — Hand off `npm publish` to the user

**Do not run `npm publish` yourself.** Stop here and ask the user to run it manually. The reason: `npm publish` typically requires an OTP from a 2FA app, and the user is the only one who can read their authenticator. Even when an inline `--otp=` would work in principle, having the human do the actual registry write is a useful safety checkpoint — every published version is permanent.

Tell the user the exact command to run, picked from these:

```bash
npm publish                       # unscoped package
npm publish --access=public       # scoped package (@org/name) — defaults to private otherwise
npm publish --tag next            # pre-release, doesn't go to `latest`
```

If a `release` script exists in `package.json` (e.g. `"release": "npm publish --access=public"`), point the user at that instead — they've already encoded the right flags:

```bash
npm run release
```

Print the command in a clear, copy-pasteable block and wait. Don't proceed to verification until the user confirms they've run it (or reports an error).

#### Help the user with 2FA

Mention up front that npm will prompt for an OTP. Two ways the user can handle it:

**Option A — interactive prompt** (works in plain bash/zsh): just run the command and type the OTP at the prompt.

**Option B — inline OTP** (required for shells that swallow the prompt — `ble.sh`, some terminal multiplexers, CI):
```bash
npm publish --access=public --otp=123456
```

OTPs rotate every ~30 seconds. If a previous attempt 403'd despite the user being logged in, suggest Option B. Never try to type the OTP for them — only the human can read their authenticator app.

#### If the user reports the publish failed

Common errors and what they mean — diagnose and tell the user what to change, then ask them to retry:
- **E403, "Two-factor authentication required"** — needs `--otp=`.
- **E403, "Package name too similar to existing packages X,Y"** — name collision; scope it (back to Stage 2d).
- **E403, "You cannot publish over the previously published versions"** — the version in `package.json` already exists on the registry. Bump again.
- **E402, "Payment Required"** — trying to publish a private scoped package without a paid plan; add `--access=public`.
- **E404, "Not Found"** — usually a registry config issue (`npm config get registry`); check it points at `https://registry.npmjs.org/`.

### Stage 6 — Verify

After the user confirms `npm publish` succeeded, you can verify the registry side:

```bash
npm view <name>                    # confirms registry has the new version
npm view <name> versions --json    # lists all published versions
```

Optional but nice: `npx <name>@latest --version` from a different directory to confirm install actually works end-to-end.

## Sharp edges and gotchas

These are real things that have bitten real releases. Internalize them.

**Don't name a script `publish` in `package.json`.** It's a reserved lifecycle hook that runs *after* `npm publish`. If your `publish` script itself runs `npm publish`, you get infinite recursion. Use `release` instead.

**`npm version` refuses on a dirty tree.** This is a feature — it forces you to commit first so the tag is meaningful. Don't suppress with `--force` unless you understand why.

**Scoped packages default to private.** `@org/name` requires `--access=public` on first publish, or it errors with E402 (or silently goes to a paid private package on accounts that have one — even worse). Always pass it explicitly for scoped packages.

**`prepublishOnly` runs on `npm publish`, not on `npm pack`.** So a clean `npm pack --dry-run` doesn't prove the build works. You need an explicit `npm run build` before, or trust `prepublishOnly` to run during the real publish (it does).

**Version numbers are permanent.** `npm unpublish` exists but is restricted (72 hours after publish, only if no other package depends on it) and discouraged. Even after unpublish, you cannot republish the same version number. Plan the version bump like it's a database migration.

**The git tag is meaningless without a push.** Forgetting `git push --follow-tags` is the most common "release" bug — npm has the new version, GitHub doesn't have the tag, and now release notes/changelog automation is broken.

**Don't skip the dry-run pack to "save time".** It is the cheapest possible insurance against shipping a credentials file. Ten seconds of reading file names beats an hour of revoking tokens.

## Decision shortcuts

If the user has a `release` script and a clean tree and a published-before package and 2FA configured cleanly: do all the prep, then ask them to run:

```bash
npm run release
```

If anything is non-default (first publish, dirty tree, scoped name change, no `release` script), walk the full workflow above. Don't skip stages just because the user is in a hurry — every stage exists because skipping it broke a real release.

## What the user sees

Communicate progress clearly. After Stage 4 (push), summarize what's been prepped and tell the user the exact command to run:

> Ready to publish `@zeiq/locca@0.1.0`:
> - 33 files, 38.9 kB tarball
> - Smoke test passed
> - Tag `v0.1.0` pushed to `main`
>
> Run this to publish (you'll be prompted for your 2FA OTP):
> ```
> npm publish --access=public
> ```
>
> Let me know once it's done (or paste the error if it fails).

After the user confirms success, verify with `npm view` and report the install command:

> Confirmed on the registry. Users can now install with:
> `npm install -g @zeiq/locca`

Don't be silent through the workflow — each stage's result is information the user wants. But don't over-narrate either; one line per stage is enough. The one place to be explicit is Stage 5: the user needs to know the workflow has paused and is waiting on them.
