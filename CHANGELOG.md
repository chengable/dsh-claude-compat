# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

All notable changes to this project are documented here. Versions follow [SemVer](https://semver.org/).

## [1.1.5] — 2026-11-03

### Fixed
- **Hook notices are actually visible in the desktop client.** They were delivered with `source.form: 'notice'`, and the client routes a declared notice through its context-row renderer — which needs a producer it recognizes. An unknown producer silently produced no row, so the message existed in the session log and in the model's request while the page showed nothing. Notices now use `form: 'hook-context'`, the same form this plugin already uses for SessionStart / UserPromptSubmit context, which renders as an opaque block (the claude-mem blocks at the top of every turn are that path).

## [1.1.4] — 2026-11-03

### Fixed
- **Hook notices render again, and survive a restart.** v1.1.3 appended the notice straight to the session surface (`surfaceOp: 'append'`): it reached the log and the model's next request, but the web client does not render that as its own notice bubble, so nothing was visible. The inbox path (a claimed user message) is the one that renders, so notices are queued for the next prompt again — and the queue is now persisted per session, so a restart between the Stop and the next prompt no longer loses it.

## [1.1.3] — 2026-11-03

### Fixed
- **A Stop-hook notice now appears at the end of its own turn.** The notice was buffered until the next prompt, so (a) it needed a second message before it became visible and (b) a restart in between discarded it — the queue lived only in the process. It is now appended straight to the session surface (`surfaceOp: 'append'`, the same call DSH uses for runtime context), with the buffer kept only as a fallback for sessions that cannot take an append.

## [1.1.2] — 2026-11-03

### Fixed
- **Hook notices no longer show terminal color escapes.** claude-evol prints its review reminder with `\u001b[1m\u001b[93m`, so the notice arrived in the transcript as raw escape garbage. Terminal color is stripped before display, the way Claude Code does it.

## [1.1.1] — 2026-11-03

### Added
- **Hook chatter is visible in the transcript.** A Stop hook's plain stdout (and the explicit `systemMessage` field) is what Claude Code shows as hook output — claude-evol's "以下 N 个会话已达审查阈值" reminder is exactly that. DSH has no hook-output channel, so the bridge now carries the text to the **next prompt** as a `form: 'notice'` user message. It is buffered at the turn boundary rather than injected there, because injecting at `agent/turn-stopping` would keep the finished turn open. New `surfaceHookOutput` (default `true`) turns it off.

### Fixed
- **A failing hook is no longer silent.** An exit code other than 0 (success) or 2 (deliberate block) is a broken hook; Claude Code surfaces it, and staying quiet made an upgraded-broken plugin look identical to a working one. It now logs a non-blocking warning.
- **Plugin MCP server names carry Claude Code's `plugin_` segment**: `mcp__plugin_<plugin>_<server>__<tool>`. Permission rules and hook matchers are written against that exact name, so the previous `mcp__<plugin>_<server>__<tool>` shape could never match them.

### Tests
- Hook-notice decoding/merging (`test/v110.test.js`); suite: 97 tests, all green.

## [1.1.0] — 2026-11-03

### Added
- **Claude Code hooks run natively — no second plugin needed.** All nine events the harness has a seam for are bridged: `SessionStart` (context injection), `UserPromptSubmit` (block / add context), `PreToolUse` (deny / ask), `PostToolUse` and `PostToolUseFailure` (block / add context), `Stop` (force another step), `SubagentStart` / `SubagentStop`, and `SessionEnd`. Sources: `~/.claude/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`, and every installed plugin's `hooks/hooks.json` (or the files its manifest `hooks` field names) — plugin hooks used to be invisible, which is why hook-driven plugins such as claude-mem could never work here. A plugin hook's `${CLAUDE_PLUGIN_ROOT}` is substituted and exported to its process.
- **Hook semantics now match Claude Code.** Payloads carry the real field set (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, per-event fields) with the trailing newline; commands run in the session workspace with `CLAUDE_PROJECT_DIR` exported; matchers use Claude's dialect (word-and-`|` = literal alternation, anything else = unanchored regex); decisions follow the reference mapping (exit 2 blocks with stderr as the reason, `hookSpecificOutput.permissionDecision` allow/deny/ask, `additionalContext` injected, `continue: false` halts, `async: true` runs detached). `Notification`, `PreCompact` and `Setup` have no seam and are reported instead of dropped.
- **MCP: the whole Claude Code scope hierarchy.** Local (`~/.claude.json` → `projects[<path>].mcpServers`), project (`.mcp.json`), user (`~/.claude.json` → `mcpServers`) and plugin servers are collected and merged with Claude Code's precedence (a higher scope wins the whole entry). Plugin servers are namespaced `plugin_<plugin>_<server>` so permission rules and hook matchers written for Claude Code keep matching.

### Fixed
- **Project-scoped hooks and `.mcp.json` were silently invisible in the desktop app.** Both resolved from `process.cwd()`, and a DSH host runs from its profile directory — so a project's `.claude/settings.json` and `.mcp.json` were never found, with no log line. Both now resolve from the **session workspace**, and the first session supplies it when startup has none.
- **Hook configs are read per workspace and cached**, invalidated by `/reload-cc-plugins`; editing settings or installing a plugin no longer needs a process restart to be seen (previously read once at activation).
- **MCP variable expansion**: `${VAR}`, `${VAR:-default}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` are expanded in command/args/env/url/headers, with Claude Code's guard that blanks credential variables in remote URLs/headers. An inline manifest `mcpServers` had bypassed substitution entirely (the CHANGELOG had promised otherwise since 1.0.2).
- **MCP fields the layer used to ignore**: `timeout` (was hard-coded to 60 s), `disabled`, and the transports DSH lacks — `ws`/`sdk` are skipped with a warning, legacy `sse` mounts as streamable-http with a warning, and a `url` without `type` warns instead of silently mounting.
- **MCP collisions are deterministic**: one module-level mount registry plus sequential mounting replaces two racing fire-and-forget mounts, so a project server and a plugin server can no longer both register the same name; truncated server names now keep a hash so two long names stay distinct.
- **Plugin `commands` as an array was ignored** — a real plugin declaring `["./.claude/commands", "./commands"]` lost all eight of its commands. Arrays are honored for skills, commands and agents, and a declared `skills` field now ADDS to the conventional `skills/` scan instead of replacing it.
- **`enabledPlugins: false` is honored**, so `/cc-plugin disable` actually disables a plugin (its skills, commands, agents, hooks and MCP servers); project-scope-only plugin installs are surfaced instead of dropped.
- **`disable-model-invocation` and `argument-hint` now apply to `.claude/commands`**, and a command using `$ARGUMENTS` says where the arguments are instead of leaking the literal placeholder.
- **Skills without a `description` are kept** (described by their first body line, as Claude Code does) instead of being dropped, and `when_to_use` is read alongside `whenToUse`.
- **`.claude/agents` keep more than a body**: the delegation header now carries the agent's `model`, `tools` and `skills`.

### Tests
- `test/v110.test.js` (hooks: sources, plugin discovery, workspace resolution, payloads, codec, merge), `test/v111.test.js` (MCP: expansion, transports, scopes, precedence, namespacing) and `test/v112.test.js` (plugin components, `enabledPlugins`, command arguments, agent header). Suite: 96 tests, all green.

## [1.0.4] — 2026-11-03

### Tests
- **`npm run check` is green on any machine.** Two cases in `test/v050.test.js` asserted against the real `~/.claude/plugins` installs (`oh-my-claudecode` present in the registry; ≥40 skills, ≥20 commands, ≥15 agents discovered from it), so the suite failed on every machine without that exact plugin — and every "did the tests pass?" answer needed a "...except two environment-dependent failures" caveat. Both cases now build their own plugins root and plugin in a temp dir, in the layout Claude Code actually writes (`<root>/installed_plugins.json` plus `<root>/cache/<marketplace>/<name>/<version>`), and assert the same thresholds, the same candidate shape, and the same cross-kind `skills/ask` vs `commands/ask.md` rule. Registry edge cases that had no coverage are pinned alongside: the last `user` record wins after a reinstall, `project`-scope records are skipped, a record with no `installPath` is dropped, and a key without `@` carries no marketplace. `enableAgents: false` hiding agents is covered too. Nothing reads the machine's real `~/.claude`, so the suite passes everywhere and stops rotting when the plugin upgrades or is uninstalled.

## [1.0.3] — 2026-11-03

### Changed
- **`enablePluginMcp` now defaults to `true`.** Mounting the MCP servers that installed Claude Code plugins declare used to require a profile `cordis.patch.yml` row. A profile row does not survive a plugin reinstall — the patch layer is repaired or replaced and the plugin silently returned to "no plugin MCP servers", with no message. The wanted configuration now lives in the schema, so it is restored by the install itself. Set `enablePluginMcp: false` to keep plugin MCP servers off.

### Tests
- `test/v103.test.js` pins the defaults (`enablePluginMcp`, `projectRootMarkers`, the skill/rules surface) so a reinstall cannot regress them back to opt-in.

## [1.0.2] — 2026-11-03

### Fixed
- **Plugin MCP servers are discovered in every layout Claude Code accepts.** `translatePluginMcp()` only understood a manifest `mcpServers` that was a *path string*; any other shape produced zero servers and zero warnings. Most marketplace plugins keep their servers in a separate `<installPath>/.mcp.json` (claude-mem's `mcp-search` is exactly that), and an inline `mcpServers` map is equally valid — both were dropped, so `enablePluginMcp: true` mounted nothing. Resolution order is now: inline object → path string → conventional `<installPath>/.mcp.json`, with `${CLAUDE_PLUGIN_ROOT}` substituted in every case. A malformed `mcpServers` value and an unreadable declared path now warn instead of disappearing; a plugin with no MCP config anywhere still resolves quietly to zero servers.

### Tests
- `test/v102.test.js`: the claude-mem layout (manifest without `mcpServers` + `./.mcp.json`), inline object, path string precedence, `${CLAUDE_PLUGIN_ROOT}` substitution, unreadable path warning, malformed value warning, and the authoritative empty map.

## [1.0.1] — 2026-11-03

### Fixed
- **Project-scoped discovery no longer disappears in a non-git working directory.** `findProjectRoot()` returned `undefined` once it reached the filesystem root without finding a marker, so `list()` and the rules injector skipped `<projectRoot>/.claude/{skills,commands,agents,rules}` entirely — no entries, no warning. Claude Code itself has no such requirement: `claude` reads `.claude/` from a plain directory too. Both helpers now fall back to the session cwd when no marker matches, which is exactly what DSH's own `dsh-skill-filesystem` does for its project roots. `projectRootMarkers` also defaults to `[".git", "CLAUDE.md"]`, so a session opened in a subdirectory still resolves the project root.
- **A plugin manifest that omits `skills` / `commands` no longer hides the plugin's content.** The discovery code treated a present-but-empty field as "this plugin ships nothing", so any marketplace plugin relying on the conventional layout contributed zero skills — silently. This dropped 22 skills from `claude-mem`, and the skills of `skill-creator`, `plugin-dev`, `agent-morph`, `claude-evol`, `codex`, `minimax-skills` and `minimalist-entrepreneur`. An absent field now means `<installPath>/skills` / `<installPath>/commands`, matching the no-manifest branch and Claude Code's optional-field semantics. `pluginSkillDirs()` / `pluginCommandsDir()` are exported so the rule is unit-tested.
- The process-lifetime `.mcp.json` mount opts out of the cwd fallback (`fallbackToCwd: false`): it stays root-scoped, because the DSH process can be launched from any directory.
- `/cc-export` reports `No DSH skills in <dir>` for a marker-less directory instead of `No project root found (no .git)`, since such a directory is now its own project root.

### Tests
- `test/v101.test.js`: marker fallback (async + sync), nearest-marker precedence, `CLAUDE.md` as a default marker, `fallbackToCwd: false`, the plugin skill/command dir rules (manifest with/without/declared/empty), user-scope-only plugin records, and an end-to-end `discoverPluginContent` case for a manifest without `skills` (skipped when the DSH peer packages are absent).

## [1.0.0] — 2026-10-30

### Added
- **Published to the DSH plugin market.** The repo now hosts a market index — `site/index.json`, deployed to GitHub Pages by `.github/workflows/market.yml`. Add `https://biedongbin.github.io/dsh-claude-compat/index.json` as an index source in the 插件市场「发现」 tab to browse and install every release. `scripts/update-market-index.mjs` regenerates the index from the npm registry (non-deprecated versions declaring `dsh.bundle`, matching the official generator's rule); versions already listed are preserved across reruns, so run it after `npm publish` and commit to pick up the new release. 0.9.2 was packed but never pushed to npm — the registry jumps from 0.9.1 straight to 1.0.0.

## [0.9.2] — 2026-10-28

### Added
- **Native DSH slash commands for the manager surface** (`/cc-resume`, `/cc-plugin`, `/cc-export`, `/reload-cc-plugins`, `/reload-skills`). DSH's `@deepseek-ai/dsh-commands` service (mounted in the shipped Web host) lets a plugin register host-executed human commands: the handler runs in the DSH process when the user submits the slash line, and the result text is rendered by the UI directly — command discovery, execution, and output add **no model tokens** and never enter model history (each run is logged as a log-only `command/run`+`command/done` pair). Handlers spawn this package's own CLIs (`scripts/cc-resume.mjs`, `scripts/cc-export.mjs`) with the **session** cwd pinned via `--cwd` (the host process cwd is not the workspace), `/cc-plugin` reuses `runPluginCommand`, and the reload commands call the skill registry's `control.invalidate()` directly. Registration goes through the runtime guard `ctx.inject(['commands'], …)` — the exact pattern of the built-in `dsh-plan-mode` — so hosts without the service (UI-less spines, ACP automation, older builds) silently keep the skill path. Covered by `test/v092.test.js`.

### Changed
- **The five manager skills left the user's slash menu** (`userInvocable: false`, still `modelInvocable: true`): the human entry point is now the native command, so the menu shows one entry per surface instead of a command + a model-mediated skill; the model keeps the loadable-instructions fallback.

## [0.9.1] — 2026-10-28

### Fixed
- **Manager skills were listed but could never load (`skill "cc-plugin" is unknown or no longer available`)** — affected all five inline skills (`/cc-plugin`, `/reload-cc-plugins`, `/reload-skills`, `/cc-resume`, `/cc-export`). The DSH registry loads every definition exclusively through `provider.get(candidate)`; a candidate-carried `get()` closure is never called. These skills carried their bodies in exactly such a closure, and their locator held `import.meta.url` (a `file://` URL) that `provider.get()` then tried to read from disk — `readTextSafe(file://…)` returns `undefined`, so the registry reported the skill as unknown. Two latent defects died with the closure: it returned `{ body }` where `validateDefinition` requires `{ content }`, and `/reload-cc-plugins`' cache drop (`control.invalidate()`) lived inside it, so reload never actually reloaded. Bodies and the invalidate flag now travel in the locator (`{ kind: 'inline', body, invalidate }`); `provider.get()` serves inline candidates directly and fires `invalidate()` at load time — loading the reload skill IS the reload. Resolves the 0.7.0 "known issue": the root cause was this plugin's dead closure, not DSH runtime layering. Covered by `test/v060.test.js` and a real-`SkillRegistry` load assertion in `test/self-check.test.js`.
- **`/cc-plugin` HELP copy said `/plugin` throughout** while the skill is invoked as `/cc-plugin`; now consistent, and the Execution section explicitly tells the model to run `claude plugin <args>` via bash (`runPluginCommand` has no DSH tool mount, so the body is the only execution path).

### Tooling
- **npm tarball ships only the runtime scripts.** `files` previously globbed the whole `scripts/` directory, publishing maintainer-only tooling (`deploy-local.sh` — checkout→profile deploy with a macOS app-path hint, meaningless elsewhere; `gen-downloads-chart.mjs`) alongside the four scripts the installed plugin actually needs (`cc-resume.mjs`, `cc-export.mjs`, `zstd-compat.mjs`, `dsh-restart.sh` for the `bin`). Both dev scripts stay in the repo; only the published package slims down.

## [0.9.0] — 2026-10-28

### Added
- **`skillAliases`: make Chinese (and any non-ASCII) skill names usable.** DSH fixes the skill-name grammar to kebab-case (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, defined in `@deepseek-ai/dsh-skill` and checked by the registry before `get()`), so a Chinese name emitted by the plugin still fails one layer down with `return void 0` — until now the only option was to drop it. Map it to a legal slug instead: `skillAliases: { "三脑": "san-nao" }`; the original name stays at the front of the description (`三脑 — …`, disable with `aliasDescriptionPrefix: false`). The map applies to skills, commands, agents and plugin skills alike. A legal name always beats an alias, and aliased entries keep their provider rank, so collisions with DSH-native or `~/.agents` skills dedupe exactly as before. Covered by `test/v090.test.js`.

### Fixed
- **Non-kebab skills were dropped silently.** `skills`, `commands`, `agents` and plugin commands all did a bare `continue`; the only way to learn what was missing was to read the source. Each file now warns once per process with a paste-ready `skillAliases` example.

### Tooling
- **`scripts/deploy-local.sh`**: copy this checkout's `src/` into an installed DSH profile (`~/.dsh/profiles/<profile>/node_modules/dsh-claude-compat`) with a timestamped backup. DSH imports the installed copy at process start, so editing a checkout otherwise changes nothing. (`bash scripts/deploy-local.sh --help`.) Contributed in PR #3.

_Contributed by @liujunctz123-jpg (PR #3)._

## [0.8.4] — 2026-10-18

### Fixed
- **New sessions failed to load on dsh 0.2.0 (`format v4 message requires a producer-owned source kind`)**: session format v4 admission (`session-format-v3-to-v4/src/message-sources.ts`) rejects the retired V3 wrapper `source.kind: 'plugin'` — a third-party producer must declare its own kind. All three injection sites (rules in `index.js`, hook-context in `hooks.js` ×2) still emitted the wrapper, so every session in a project with `.claude/rules/*.md` failed admission at load. Injection now emits `source.kind: 'plugin:dsh-claude-compat'` with the `plugin` field dropped — the exact kind dsh's own `producerKind()` derives for us (not in `RENAMED_PRODUCERS`/`RELEASED_SAME_NAME_PRODUCERS` → `plugin:${plugin}`), so 0.8.3 logs migrated by dsh and messages written today converge on one value. Duplicate-injection detection compares the shared `CLAUDE_COMPAT_SOURCE_KIND` constant. Regression covered by `test/v080.test.js` and verified against the real admission predicate in `test-evidence/verify-084-v4-admission.mjs`. Issue #2.

## [0.8.3] — 2026-09-30

### Fixed
- **Rules dedup scan used the wrong event lookup**: the pre-step hook took one `snapshotEvents()` snapshot and indexed it by surface seq (`events[seq]`). Snapshot indices and session seqs are not guaranteed to align (dsh has `firstLiveSeq`/offset semantics), so the duplicate-injection check could silently miss. Now uses `session.eventAt(seq)` — the exact-lookup API dsh core itself uses for surface scans — with an optional `session.events?.[seq]` fallback for pre-0.1.2 hosts. Based on PR #1 by @SvenKunkka.

## [0.8.2] — 2026-09-30

### Fixed
- **Session archives unreadable after dsh upgrade (`cannot safely transform unclassified message source`)**: injected messages carried a custom `source.kind: 'claude-compat'`, which is not in dsh's migration whitelist (`SOURCE_KINDS`), so any session log containing one failed v0→v3 migration fail-closed and could not load. Injection sources (rules in `index.js`, hook-context in `hooks.js`) now use the whitelisted `kind: 'plugin'` with `plugin: 'dsh-claude-compat'` — the same shape dsh core plugins (`@deepseek-ai/dsh-system-prompt`, `user-approval`) already write. Duplicate-injection detection updated to match the new identity.

## [0.8.1] — 2026-09-08

### Fixed
- **Resume crash (`Cannot read properties of undefined (reading '7')`)**: the rules `agent/pre-step` hook indexed `agent.session.events[seq]`, but dsh 0.1.2-rc.1's `Session` has no `events` property — the public API is `snapshotEvents()`. On a resumed session the surface is non-empty, so the first `.some()` callback threw and the turn failed with `code UNKNOWN`. The hook now takes one `snapshotEvents()` snapshot outside the loop and indexes that. New sessions were unaffected (empty surface short-circuits).

## [0.8.0] — 2026-08-19

### Added
- **Session lifecycle hooks**: `SessionStart` → `agent/session-start`, `SessionEnd` → `agent/disposed`. Fire-and-forget (best-effort, non-zero exit logged, never blocks the loop). Payload carries `session_id` + `cwd`.
- **`/cc-export`**: export DSH-native skills (`.dsh/skills`) into Claude Code `.claude/skills/<name>/SKILL.md` with frontmatter preserved; multiline values emit as YAML literal blocks. `list` / `export [--overwrite] [--target]`.

### Fixed
- **Session hook agent extraction**: DSH agent events dispatch `(carrier, name, payload)` and pass the agent on the **first argument** (`carrier.agent`), not the payload — verified in an isolated sandbox. Listeners now read `carrier?.agent ?? payload?.agent` (defensive against agent-loop's fused-payload path). Previously `session_id` was always `'unknown'`.

## [0.7.0] — 2026-08-18

### Added
- **`/cc-resume` — Claude Code session resume**: list conversations stored under `~/.claude/projects/<munged-cwd>/*.jsonl` (id, date, message count, first-user-text preview, imported marker) and import any session into DSH as a native event-sourced log (`~/.dsh/sessions/<munged>/session-cc-<id>/session.jsonl.zstd`). Imported sessions carry full user/assistant/tool history, a `cc: <preview>` title, and open/resume like any DSH session.
- Translation rules: main thread only (Claude sidechains skipped); thinking blocks dropped (DSH reasoning is stream-chunk based); tool_use/tool_result paired into DSH `tool/call`/`tool/result` events; `--limit-turns N` imports just the tail of huge sessions; idempotent re-import.
- **zstd frame layout fix**: the session header line is compressed as its own first zstd frame (DSH's `assertZstdHeaderFrame` requires it), events follow in a second frame — single-frame compression made DSH fail to parse imported logs.

- `scripts/cc-resume.mjs` is also a standalone CLI (`list` / `import <sessionId>`); requires the `zstd` binary on PATH.

### Known issues
- The `skill` tool may fail to resolve plugin-provided skills (`unknown or no longer available`) in agent-scoped runtime layers even though the catalog lists them — a DSH runtime layering behavior. `/cc-resume` degrades gracefully: run `scripts/cc-resume.mjs` directly (the skill body only wraps the CLI). **Resolved in 0.9.1 — root cause was this plugin's never-called inline closure, not DSH.**

## [0.6.2] — 2026-08-18

### Changed
- **Renamed built-in commands**: `/plugin` → `/cc-plugin`, `/reload-plugins` → `/reload-cc-plugins`. The generic `plugin` name was likely to collide with DSH-native or third-party skills; the `cc-` prefix marks Claude Code bridge commands unambiguously. `/reload-skills` kept as an alias.

### Added
- **`scripts/dsh-restart.sh`** — portable, safe DSH Web restart with idempotent terminal-bash prompt patch:
  - Zero hardcoded user paths: discovers `dsh` via PATH, nvm, or npx cache (`~/.npm/_npx/*/node_modules/.bin/dsh`).
  - Patches **every** installed copy of `dsh-terminal-bash` found on the machine.
  - Cross-platform `sed` (GNU/BSD), SIGKILL fallback, startup-crash detection, `--no-patch` mode, `DSH_RESTART_PORT` override.
  - Shipped in the npm tarball (`files`) and exposed as bin alias `dsh-claude-compat-restart`.
- README: built-in commands section, `enablePluginManager`/`pluginManagerRank` config entries, troubleshooting section (both languages).

## [0.6.1] — 2026-08-18

### Added
- **`/reload-plugins` (now `/reload-cc-plugins`) and `/reload-skills`** — hot catalog reload. Loading the reload skill definition IS the reload: `get()` calls the provider control's `invalidate()`, bumping the registry revision, dropping the collect cache, and broadcasting `skills/change` so the Web GUI skill picker refreshes **in the current session** — no restart, no new session needed. Plugin-shipped MCP servers still require a process restart.

## [0.6.0] — 2026-08-18

### Added
- **`/plugin` (now `/cc-plugin`) — full Claude Code plugin & marketplace management** as a user-invocable DSH skill:
  - Subcommands mirroring `claude plugin`: `list`, `install <name>[@marketplace]` (incl. one-shot `/cc-plugin name@market`), `uninstall`, `enable`, `disable`, `update [name]`, `search <term>`, `marketplace list|add|remove|update`.
  - Execution engine: **claude CLI first** (`claude plugin ...` when on PATH), **self-implemented fallback** (direct JSON + git manipulation) when unavailable — every mutated file gets a timestamped backup.
  - All state stays in Claude-native locations (`~/.claude/plugins/installed_plugins.json`, `known_marketplaces.json`, `~/.claude/settings.json` `enabledPlugins`) so Claude Code and DSH read the same truth; newly installed plugin content surfaces via the existing discovery bridge.
  - Hermetic test suite for the manager (`test/v060.test.js`); real-CLI lifecycle (install → disable → enable → uninstall) verified end-to-end against `claude` 2.1.220.

## [0.5.1] — 2026-08-17

### Fixed
- **MCP mount crash with non-promise plugin returns**: `ctx.plugin()` returns a Fiber (PromiseLike) in real cordis, but test/embedding environments may return plain objects. The `.catch` call is now guarded with a `typeof fiber.catch === 'function'` check instead of assumed. Also bumped the version to bust the pnpm tarball cache (same-name `.tgz` updates keep stale integrity checksums).

## [0.5.0] — 2026-08-17

### Added
- **Plugin marketplace support**: reads `~/.claude/plugins/installed_plugins.json` (v2 registry) and surfaces every installed plugin's skills, commands, and agents — manifest-driven (`.claude-plugin/plugin.json`) with a directory-scan fallback for manifest-less plugins. Content lands at rank `750` (the long tail: project `.claude`, DSH-native, and `~/.claude` all win same-name collisions).
- **Plugin MCP mounting (opt-in)**: `mcpServers` paths in plugin manifests translate to `dsh-mcp-client` instances when `enablePluginMcp: true`; `${CLAUDE_PLUGIN_ROOT}` is substituted with the install path.

## [0.4.0] — 2026-08-16

### Added
- **`.mcp.json` mounting**: project-root MCP server definitions translate to `dsh-mcp-client` plugin instances at DSH startup — `command` → stdio, `url` → streamable-http. Malformed entries or a missing client package degrade to a warning, never a crash. Read once per process from the launch workspace; restart to pick up edits.
- **Claude Code hooks subset**: `PreToolUse` → `tools/pre-execute` (exit 2 = deny), `PostToolUse` → `tools/post-execute` (exit 2 = block), `UserPromptSubmit` → `agent/pre-step`. Matchers support exact names, `*` wildcards, `|` alternation; commands run via `/bin/sh -c` with a Claude-style JSON payload on stdin; `hookSpecificOutput.permissionDecision` overrides honored; timeouts allow through with a warning.
- **`.claude/agents/*.md` shim**: DSH has no markdown subagent format, so each agent file becomes a delegation-shim **skill** (model- and user-invocable, `/agent-name` works). Frontmatter `name` must be kebab-case, otherwise the file stem is used; `description` maps to `whenToUse`. Same-name agents dedupe by rank like skills.

## [0.3.0] — 2026-08-15

### Added
- **User-level `~/.claude/` support**: skills, commands, rules, and `settings.json` hooks are picked up from the home directory in addition to the project. Fixed dedup priority: **project `.claude` (rank 50) > DSH native (100–600) > `~/.claude` (700)**. User rules with the same basename as a project rule are skipped.

## [0.2.0] — 2026-08-14

### Added
- **`dsh.bundle` declaration** for one-command activation: `dsh plugin --profile web add dsh-claude-compat` activates the plugin automatically — no manual `cordis.patch.yml` editing.

## [0.1.0] — 2026-08-13

### Added
- Initial release: bridges Claude Code's project `.claude/` into DeepSeek Harness.
  - `skills/**/SKILL.md` → DSH skill provider (catalog name/description, on-demand body load).
  - `commands/*.md` → user-invocable skills (`/command-name` in the slash menu).
  - `rules/*.md` → message-stream injection: concatenated, wrapped in a `<system-reminder>` envelope, prepended once per session — the same channel Claude Code uses (`prependUserContext`), which models follow reliably.

[0.8.1]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.5.1...v0.6.2
[0.6.1]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/biedongbin/dsh-claude-compat/releases/tag/v0.1.0
