<p align="center">
  <img src="https://img.shields.io/badge/dsh-plugin-blue?style=for-the-badge" alt="DSH Plugin">
</p>

<h1 align="center">dsh-claude-compat</h1>

<p align="center">
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/🌐_简体中文-点我阅读中文-red?style=for-the-badge" alt="简体中文"></a>
  <img src="https://img.shields.io/npm/dm/dsh-claude-compat?style=flat-square&label=downloads/month&color=brightgreen" alt="npm downloads/month">
  <img src="https://img.shields.io/npm/dt/dsh-claude-compat?style=flat-square&label=total%20downloads&color=blue" alt="npm total downloads">
  <img src="https://img.shields.io/npm/v/dsh-claude-compat?style=flat-square&label=version&color=blue" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-orange?style=flat-square" alt="License">
</p>

> **Reuse your entire Claude Code setup in DSH — zero migration.**
> skills, commands, rules, agents, hooks, MCP — install and they just work. Nothing to reconfigure.

---

## The 10-second pitch

You've already built up a solid `.claude/` in Claude Code — skills, slash commands, rules, agents, hooks, MCP servers. Moving to **DSH (DeepSeek Harness)** shouldn't mean rebuilding all of it.

**dsh-claude-compat is that bridge.** It carries your `.claude/` directories **verbatim into DSH** — everything works immediately. Install once, and both sides share one config: change it in one place, it updates in both.

```bash
dsh plugin --profile web add dsh-claude-compat@latest
dsh web
```

Done. Your skills show up in the `/` menu, rules inject into every new session, and you can invoke agents with `/agent-name` — all inside DSH, exactly like Claude Code.

**Or let DSH install it itself (recommended):** copy this line to DSH — it reads the skill, installs, and verifies:

> Read https://github.com/biedongbin/dsh-claude-compat/blob/main/.claude/skills/install-dsh-compat/SKILL.md and install the dsh-claude-compat plugin following its steps.

> ⭐ Find this useful? [Give it a star](https://github.com/biedongbin/dsh-claude-compat) — it keeps us improving and helps more people discover it.

---

## What it brings over — at a glance

| Your Claude Code asset | Becomes in DSH | How to use it |
|---|---|---|
| `skills/**/SKILL.md` | DSH skill (lazy-loaded) | `/skill-name`, the `skill` tool, and the model-visible catalog |
| `commands/*.md` | DSH skill (user-invocable) | `/command-name` in the slash menu |
| `rules/*.md` | message-stream injection (same channel Claude uses) | auto-applies to every new session |
| `agents/*.md` | delegation-shim skill | invoke `/agent-name` with its persona |
| `.claude/settings.json` hooks | Pre/PostToolUse + UserPromptSubmit bridged | commands, permissions, blocks behave as before |
| `<root>/.mcp.json` | `dsh-mcp-client` instances | stdio / streamable-http auto-translated |
| `~/.claude/plugins` | DSH skill (managed via `/cc-plugin`) | installed plugin skills work too |

Both the project `.claude/` and the user-level `~/.claude/` are read. Same-name entries dedupe by fixed priority: **project `.claude` > DSH native > `~/.claude`** — a project skill always wins over other copies, and a user skill never overrides a DSH-native one. `CLAUDE.md` / `AGENTS.md` are handled by DSH's built-in `dsh-agent-instructions` — **this plugin never touches them**.

## What it does (implementation detail)

| `.claude/` path | Mechanism | Behavior |
|---|---|---|
| `skills/**/SKILL.md` | DSH skill provider | Name + description in the model-visible catalog; body loads on demand via the `skill` tool. New skills appear on the next catalog reconcile — no restart. |
| `commands/*.md` | DSH skill provider | Same, plus user-invocable: `/command-name` works in the slash menu. |
| `rules/*.md` | Message-stream injection | Rules are concatenated, wrapped in a `<system-reminder>` envelope, and prepended as a user-role message at the front of the message array once per session — the same channel Claude Code uses (`prependUserContext`), which models follow reliably. |
| `agents/*.md` | DSH skill provider (delegation shim) | DSH has no markdown subagent format, so each agent file becomes a **skill** whose body leads with an explicit "delegate with this persona" instruction. Model- and user-invocable, so `/agent-name` works. Same-name agents dedupe by rank like skills. |
| `.claude/settings.json` → `hooks` | Tool/prompt hooks | Claude Code hooks subset bridged onto DSH's `tools/pre-execute` (PreToolUse), `tools/post-execute` (PostToolUse) and `agent/pre-step` (UserPromptSubmit) waterfalls. Commands run via `/bin/sh -c` with a Claude-style JSON payload on stdin; exit code 2 denies/blocks, `hookSpecificOutput` overrides are honored, timeouts allow through with a warning. |
| `<projectRoot>/.mcp.json` | MCP servers | Claude Code-format MCP server definitions are translated to `dsh-mcp-client` plugin instances at DSH startup from the launch workspace: `command` → stdio, `url` → streamable-http. Malformed entries or a missing `@deepseek-ai/dsh-mcp-client` degrade to a warning, never a crash. |
| `~/.claude/plugins` (installed plugins) | DSH skill provider | Installed Claude Code plugin-marketplace plugins contribute their skills/commands/agents (via each install's `.claude-plugin/plugin.json` manifest, or a directory scan when manifest-less) at rank `750` — the long tail: project `.claude`, DSH native, and `~/.claude` all win collisions. Plugin MCP servers (a `.mcp.json` at the plugin root, or `mcpServers` in the manifest) mount too, since `enablePluginMcp` defaults to `true`; set it to `false` to keep them off. |

The same directories are also read from the **user-level** `~/.claude/` (skills, commands, rules, agents, and `~/.claude/settings.json` hooks). Same-name skills/commands/rules/agents are deduped with a fixed priority:

**project `.claude` > DSH native (`.dsh`) > `~/.claude`**

- Project `.claude` entries carry rank `50`; DSH's own skills — project `.dsh` roots, `.agents` roots, and bundled skills (ranks `100`–`600`, `BUNDLED_SKILL_RANK`) — sit in between; `~/.claude` entries rank `700`. So a project skill always overrides the DSH-native and user copies, and a user skill never overrides a DSH-native one.
- Rule files with the same basename in `~/.claude/rules` are skipped when the project already provides one.

`CLAUDE.md` / `AGENTS.md` are **not** touched — DSH's built-in `dsh-agent-instructions` already handles those.

## Built-in commands

Installing this plugin adds three management skills to the catalog:

| Command | What it does |
|---|---|
| `/cc-plugin` | Full Claude Code plugin management: `list`, `install <name>[@marketplace]`, `uninstall`, `enable`, `disable`, `update [name]`, `search <term>`, `marketplace list\|add\|remove\|update`. One-shot syntax `/cc-plugin <name>@<marketplace>` installs directly. Engine: the `claude` CLI when available, otherwise a built-in fallback (direct JSON + git, with timestamped backups of every file it touches). All state stays in Claude-native locations (`~/.claude/plugins`, `~/.claude/settings.json` `enabledPlugins`) so Claude Code and DSH read the same truth. |
| `/reload-cc-plugins` | Hot-reload the skill catalog: drop cached provider lists and notify observers so newly installed/removed skills appear in the **current session** — no restart, no new session. |
| `/reload-skills` | Alias of `/reload-cc-plugins`. |
| `/cc-export` | Export DSH-native skills (`.dsh/skills`) into Claude Code `.claude/skills/<name>/SKILL.md` with frontmatter preserved. `list` / `export [--overwrite] [--target]`. |
| `/cc-resume` | List Claude Code conversation sessions for the current project (`~/.claude/projects/`) and import any of them into DSH with full user/assistant/tool history. Imported sessions appear in the DSH session list titled `cc: <preview>` and resume like native ones. `list` / `import <sessionId>` / `--limit-turns N` for huge sessions. |

Typical loop: `/cc-plugin install ralph-loop@claude-plugins-official` → `/reload-cc-plugins` → new skills visible immediately. Plugin-shipped MCP servers still require a DSH restart (process-lifetime mount).

## Requirements

- DSH with a profile (e.g. `web`)
- A project using Claude Code conventions: `.claude/skills/`, `.claude/commands/`, `.claude/rules/`, `.claude/agents/`, `.claude/settings.json`, and a project-root `.mcp.json` (all optional; `~/.claude/` equivalents are also picked up)
- `pnpm` on `PATH` — `dsh plugin` is a thin pnpm forwarder

## Install / Update

One command — the package declares `dsh.bundle`, so DSH activates it automatically (no manual `cordis.patch.yml` editing). Install or update to the latest release:

```bash
dsh plugin --profile web add dsh-claude-compat@latest
```

Or from GitHub:

```bash
dsh plugin --profile web add github:biedongbin/dsh-claude-compat
```

Restart DSH (`dsh web`). Done — skills show up in `/`, rules are injected into every new session.

## Configuration

| Option | Default | Description |
|---|---|---|
| `enableSkills` | `true` | Register the `.claude/skills` + `.claude/commands` + `.claude/agents` provider (project and `~/.claude`) |
| `enableRules` | `true` | Inject project + `~/.claude` `rules/*.md` into the message stream |
| `enableMcp` | `true` | Translate `<projectRoot>/.mcp.json` into mounted MCP server plugins |
| `mcpFailOnStartupError` | `false` | Forward to `dsh-mcp-client`: fail plugin startup when an MCP server fails to connect |
| `enableHooks` | `true` | Run Claude Code hooks (settings files, and every installed plugin's `hooks/hooks.json`) |
| `enablePluginHooks` | `true` | Run the hooks that installed Claude Code plugins ship (set `false` for settings-file hooks only) |
| `hooksTimeoutMs` | `60000` | Per-hook run timeout (UserPromptSubmit capped at 10s regardless) |
| `enableAgents` | `true` | Surface `.claude/agents/*.md` as delegation-shim skills |
| `skillAliases` | `{}` | Non-kebab (e.g. Chinese) name → ASCII slug map, e.g. `{ "三脑": "san-nao" }`. See “Non-ASCII skill names” below |
| `aliasDescriptionPrefix` | `true` | When an alias is used, put the original name in front of the description: `san-nao: 三脑 — …` |
| `rulesMaxBytes` | `65536` | Hard cap on total injected project rules text |
| `userRulesMaxBytes` | `65536` | Hard cap on total injected `~/.claude/rules` text |
| `projectRootMarkers` | `[".git", "CLAUDE.md"]` | Ancestor markers for project-root discovery. When none matches, the session cwd is used (matching DSH's own project roots) |
| `skillRank` | `50` | Provider rank for project `.claude` skills (wins every DSH-native collision) |
| `skillSource` | `project-claude` | Source tag for project catalog entries |
| `userSkillRank` | `700` | Provider rank for `~/.claude` skills (loses to DSH-native `600`) |
| `userSkillSource` | `user-claude` | Source tag for `~/.claude` catalog entries |
| `userClaudeDir` | `~/.claude` | User-level `.claude` directory (`~` expands to the home dir) |
| `enablePlugins` | `true` | Surface skills/commands/agents from installed Claude Code plugins (`~/.claude/plugins`) |
| `pluginSkillRank` | `750` | Provider rank for plugin content (the long tail — everything else wins) |
| `pluginSkillSource` | `claude-plugin` | Source tag for plugin catalog entries |
| `pluginsRoot` | `~/.claude/plugins` | Plugin-marketplace root (`installed_plugins.json` + `cache/`) |
| `enablePluginMcp` | `true` | Mount plugin-declared MCP servers (requires `enablePlugins` and `enableMcp`; set `false` to keep them off) |
| `enablePluginManager` | `true` | Register the `/cc-plugin`, `/reload-cc-plugins`, `/reload-skills` management skills |
| `pluginManagerRank` | `40` | Rank for the built-in management skills (top of the catalog) |

## Notes

- **Skill naming**: DSH requires kebab-case skill names. Nested skill directories are flattened (`gitnexus/gitnexus-guide` → `gitnexus-gitnexus-guide`); invalid frontmatter names fall back to the directory name.
- **MCP sources**: the full Claude Code hierarchy is read, highest precedence first — local (`~/.claude.json` → `projects[<path>].mcpServers`), project (`<root>/.mcp.json`), user (`~/.claude.json` → `mcpServers`), then plugin servers (namespaced `plugin_<plugin>_<server>`). A higher scope wins the whole entry on a name collision. `${VAR}`, `${VAR:-default}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}` are expanded; `timeout` and `disabled` are honored; `ws`/`sdk` servers are skipped with a warning and legacy `sse` mounts as streamable-http. Edits still need a DSH restart (mounts are process-lifetime).
- **MCP workspace**: the project scope resolves from the session workspace, because a DSH host runs from a profile directory. When no project root is known at startup, the first session supplies it.
- **Hooks**: all nine events DSH has a seam for run natively — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd` — from `~/.claude/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json`, and each installed plugin's `hooks/hooks.json` (or the files its manifest `hooks` field names). Matchers follow Claude Code: a word-and-`|` pattern is a literal alternation, anything else is an unanchored regex, `''`/`*` match all. Commands get the Claude-shaped JSON payload on stdin (trailing newline), run in the session workspace with `CLAUDE_PROJECT_DIR` (and `CLAUDE_PLUGIN_ROOT` for plugin hooks) exported. Decisions: exit 2 blocks (stderr is the reason), `hookSpecificOutput.permissionDecision` is `allow`/`deny`/`ask`, `additionalContext` is injected, `async: true` hooks run detached. `Notification`, `PreCompact` and `Setup` have no DSH seam and are reported once.
- **Hooks workspace**: project hook configs resolve from the session workspace (not the process cwd), so they work in the desktop app too. `/reload-cc-plugins` refreshes the cache after installing or editing plugins.
- **Rules granularity**: rules are read per new session (cached per session cwd). Editing a rule mid-session takes effect in the next session.
- **Rules content**: rules are injected verbatim as instructions to the model. Only commit rules you want the model to follow — same trust level as `CLAUDE.md`.
- **Catalog snapshot timing**: the skill catalog is snapshotted when a session is created. Skills installed or edited mid-session surface after `/reload-cc-plugins` (hot reload) or in the next session.

### Non-ASCII skill names

DSH's skill-name grammar is fixed to kebab-case (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, defined in `@deepseek-ai/dsh-skill` and enforced by the registry before a candidate is read), so **a Chinese name can never reach the registry, no matter what this plugin emits** — emitting it anyway only moves the failure one layer down (`get()` returns `void 0`).

The plugin's answer is an explicit map from the original name to a legal slug, keeping the original name at the front of the description:

```yaml
skillAliases:
  三脑: tri-brain
  读知乎: read-zhihu
```

- The `name` becomes the slug (`/tri-brain` in the slash menu); the `description` becomes `三脑 — 三脑复核（…）`.
- **A legal name always beats an alias** — a skill DSH can already load is never renamed.
- Aliased entries keep their provider's rank, so a collision with a DSH-native or `~/.agents` skill is deduped exactly like any other duplicate (a `~/.claude` alias loses to an `~/.agents` skill of the same name rather than shadowing it). Lower `userSkillRank` below 500 to make `~/.claude` win.
- Un-mapped non-kebab names no longer vanish silently: one warning per file per process, with a paste-ready mapping example.

## Known limitations

Features Claude Code has that this bridge cannot provide, because the running DSH
has no surface for them. Documented so they are not mistaken for bugs:

- **`$ARGUMENTS` / `$1` / `$N` in commands and skills.** DSH's `skill` tool takes
  only a name — there is no argument channel. The body is prefixed with a note
  telling the model that arguments are whatever the user wrote in their message,
  and the command's `argument-hint` is appended to the description. Real argument
  interpolation would need the command to be registered as a native DSH command.
- **`plugin:skill` namespaces.** DSH names cannot contain `:`, so plugin content
  is surfaced under its bare name with a `[plugin-name]` description prefix.
- **Plugin `hooks`/`mcpServers` in the new in-process "mods" format.** This
  bridge runs classic command hooks and MCP configs only.
- **Hook events without a DSH seam**: `Notification`, `PreCompact`, `Setup`.
- **MCP transports DSH lacks**: legacy SSE (mounted as streamable-http with a
  warning), WebSocket and `sdk` (skipped with a warning), OAuth and
  `headersHelper` (use a static `headers` token instead).
- **Execution prefixes** `!`cmd`` for commands, `@file` references,
  `allowed-tools`/`disallowed-tools`, per-skill `model`/`effort`, `context: fork`
  and `paths` — none has a DSH field to carry them.
- **Catalog description width**: long descriptions are truncated by DSH's catalog
  rendering (several bundled skills already exceed it).
- **Agent execution semantics**: `.claude/agents/*.md` become delegation-shim
  skills. The agent's `model`, `tools` and `skills` are surfaced in the
  delegation header rather than enforced as a runtime preset.

## Troubleshooting

### Known limitation: `/cc-resume` via the skill tool

In some DSH runtime configurations the `skill` tool resolves in an agent-scoped
layer where globally registered providers are not visible — the invocation
returns `skill "cc-resume" is unknown or no longer available` even though the
catalog lists it. This is a DSH runtime layering behavior, not a plugin bug.
The skill body only instructs the model to run the CLI, which is always
available:

```bash
node node_modules/dsh-claude-compat/scripts/cc-resume.mjs list
node node_modules/dsh-claude-compat/scripts/cc-resume.mjs import <sessionId>
```

**DSH won't start back up after a restart / port 3080 stuck.** Old process still holding the port (symptom: `EADDRINUSE` in logs). Use the bundled restart script — it waits for a clean stop, falls back to SIGKILL, and verifies the port before reporting success:

```bash
npx dsh-claude-compat-restart        # bin alias (installed with the package)
bash node_modules/dsh-claude-compat/scripts/dsh-restart.sh   # direct
bash scripts/dsh-restart.sh --no-patch   # skip the prompt patch, restart only
```

The script also re-applies the idempotent `dsh-terminal-bash` prompt patch, which npx/npm updates silently revert. `DSH_RESTART_PORT` overrides the port (default 3080).

**Installed a plugin via `/cc-plugin` but its skills don't show.** Run `/reload-cc-plugins`. Still missing → restart DSH (plugin-shipped MCP servers always need a restart).

**`/cc-resume` import fails on compression.** The importer needs the `zstd` binary (macOS: `brew install zstd`; most Linux images ship it).

**`/cc-plugin` reports "claude CLI unavailable".** The fallback engine handles install/enable/disable; for marketplace add/update, install Claude Code (`npm install -g @anthropic-ai/claude-code`) or manage marketplaces from Claude Code directly.

## Release notes

- **[Changelog](CHANGELOG.md) ([简体中文](CHANGELOG.zh-CN.md))** — release history from 0.1.0 to the latest version.

## Acknowledgments

- [Linux.do](https://linux.do) — community
- [Claude Code](https://claude.com/claude-code) — the `.claude/` conventions this plugin bridges
- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) — the runtime this plugin extends

## License

[MIT](LICENSE)

## 📈 NPM Downloads

![NPM Downloads](.github/assets/downloads.svg)

[Data: api.npmjs.org](https://www.npmjs.com/package/dsh-claude-compat) · [npmtrends](https://npmtrends.com/dsh-claude-compat/)

## ⭐ Star History

If this project helps you, please give it a ⭐ — it motivates us to keep improving.

<p align="center">
  <img src="https://img.shields.io/github/stars/biedongbin/dsh-claude-compat?style=for-the-badge&logo=github&color=gold" alt="GitHub Stars">
  <img src="https://img.shields.io/github/forks/biedongbin/dsh-claude-compat?style=for-the-badge&logo=github" alt="GitHub Forks">
  <img src="https://img.shields.io/github/watchers/biedongbin/dsh-claude-compat?style=for-the-badge&logo=github" alt="GitHub Watchers">
</p>

<div align="center">
  <a href="https://www.star-history.com/#biedongbin/dsh-claude-compat&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=biedongbin/dsh-claude-compat&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=biedongbin/dsh-claude-compat&type=Date" />
      <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=biedongbin/dsh-claude-compat&type=Date" width="760" />
    </picture>
  </a>
</div>
