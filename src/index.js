// dsh-claude-compat — bridge Claude Code's .claude/ into DSH.
//
// Contributions to the live runtime:
//   1. Skill provider on ctx.skills — scans <projectRoot>/.claude/skills/**/SKILL.md,
//      <projectRoot>/.claude/commands/*.md and <projectRoot>/.claude/agents/*.md
//      (plus the user-level ~/.claude equivalents), surfaces them as DSH skills
//      so the `/skill-name` slash trigger, the `skill` tool, and the
//      model-visible catalog pick them up natively. Only name+description load
//      at discovery; the body loads on demand — same contract as the shipped
//      filesystem provider. Agents are a delegation shim: DSH has no markdown
//      subagent format, so each agent file becomes a skill whose body leads
//      with an explicit "delegate with this persona" instruction.
//   2. Rules message-stream injection — injects <projectRoot>/.claude/rules/*.md
//      and ~/.claude/rules/*.md as ONE user-role <system-reminder> message
//      prepended at the front of the message array, once per session
//      (agent/pre-step). This mirrors Claude Code's prependUserContext channel,
//      which models follow reliably. Same-name rule files are deduped,
//      project .claude winning over ~/.claude.
//      CLAUDE.md / AGENTS.md are already handled by dsh-agent-instructions,
//      so we do NOT re-inject them here.
//   3. Hooks (Claude Code subset PreToolUse/PostToolUse/UserPromptSubmit) from
//      .claude/settings.json — bridged onto tools/pre-execute,
//      tools/post-execute and agent/pre-step (see src/hooks.js).
//   4. MCP servers from <projectRoot>/.mcp.json — mounted as dsh-mcp-client
//      plugin instances at startup from the launch workspace (see src/mcp.js).
//
// Skill name flattening: .claude/skills/gitnexus/gitnexus-guide/SKILL.md →
// "gitnexus-gitnexus-guide" (DSH skill names must be kebab-case; the shipped
// provider is one-level only, we recurse up to 3 and join segments with '-').
//
// Commands: .claude/commands/commit-changes.md → skill "commit-changes",
// user-invocable forced true so `/commit-changes` works in the slash menu.
//
// Precedence (DSH registry semantics: candidates sort by rank ascending and
// duplicate skill names are first-wins — LOWER rank wins). The native ladder
// is project-dsh 100, project-agents 200, custom 300, user-dsh 400,
// user-agents 500, DSH bundled 600 (fixed BUNDLED_SKILL_RANK). This plugin
// emits project .claude at rank 50 and ~/.claude at rank 700, so conflicts
// resolve as: project .claude > DSH native (600) > ~/.claude.
//
// Rules are read once per session (cached per session cwd, from
// agent.session.header.cwd — NOT process.cwd(), the DSH process may be
// launched from anywhere). Editing a rule mid-session takes effect in the
// next session.

import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { discoverAgents, renderAgentContent } from './agents.js';
import {
  normalizeAliases,
  resolveCandidateName,
  warnUnmapped,
  withOriginalName,
} from './aliases.js';
import { invalidateHookCache, registerHooks } from './hooks.js';
import { mountMcpServers, mountMcpConfigs } from './mcp.js';
import { registerManagerCommands } from './commands.js';
import { discoverPluginContent, readInstalledClaudePlugins, translatePluginMcp } from './plugins.js';
import {
  CLAUDE_COMPAT_SOURCE_KIND,
  DEFAULT_PROJECT_ROOT_MARKERS,
  findProjectRoot,
  findProjectRootSync,
  listMdFilesSync,
  parseFrontmatter,
  readTextSafe,
  resolveUserClaudeDir,
  stringField,
} from './lib.js';

export const name = 'claude-compat';
export const inject = ['skills'];

export const Config = z.object({
  // See DEFAULT_PROJECT_ROOT_MARKERS: `.git` alone silently disabled project
  // discovery for every project that is not a git repository.
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  // DSH dedupes by rank ascending (lower wins). 50 beats the DSH-native
  // project roots (100/200) and the bundled root (600) — project .claude wins
  // every collision. 700 loses to bundled 600 — DSH native wins over
  // ~/.claude. Final priority: project .claude > DSH native > ~/.claude.
  skillRank: z.number().default(50),
  skillSource: z.string().default('project-claude'),
  userSkillRank: z.number().default(700),
  userSkillSource: z.string().default('user-claude'),
  userClaudeDir: z.string().default('~/.claude'),
  rulesMaxBytes: z.number().default(65536),
  userRulesMaxBytes: z.number().default(65536),
  enableRules: z.boolean().default(true),
  enableSkills: z.boolean().default(true),
  enableMcp: z.boolean().default(true),
  mcpFailOnStartupError: z.boolean().default(false),
  enableHooks: z.boolean().default(true),
  // Run the `hooks/hooks.json` that installed Claude Code plugins ship (or the
  // files their manifest's `hooks` field names). On by default: a Claude Code
  // user already trusts these plugins, and a plugin whose hooks never fire is
  // silently half-working. Set `false` to run only settings-file hooks.
  enablePluginHooks: z.boolean().default(true),
  hooksTimeoutMs: z.number().default(60000),
  enableAgents: z.boolean().default(true),
  // Non-ASCII (e.g. Chinese) skill/command/agent names can never satisfy DSH's
  // kebab-case grammar, so they are dropped by the registry. `skillAliases`
  // maps the original name to an ASCII slug the registry accepts —
  // { "三脑": "san-nao" } — and the original name is kept at the front of the
  // description so the catalog still reads "san-nao: 三脑 — …". Aliased entries
  // keep their provider rank, so dedupe against DSH-native and ~/.agents names
  // behaves exactly like any other collision.
  skillAliases: z.dict(z.string()).default({}),
  aliasDescriptionPrefix: z.boolean().default(true),
  // Claude Code plugin-marketplace installs (~/.claude/plugins). Skills,
  // commands and agents surface at pluginSkillRank (750: the long tail —
  // everything else wins collisions).
  enablePlugins: z.boolean().default(true),
  pluginSkillRank: z.number().default(750),
  pluginSkillSource: z.string().default('claude-plugin'),
  pluginsRoot: z.string().default('~/.claude/plugins'),
  // Mount the MCP servers that installed plugins declare (`.mcp.json` or a
  // manifest `mcpServers`). Defaults to true in this fork: a Claude Code user
  // already trusts these plugins, and requiring a profile patch to opt in meant
  // every reinstall silently dropped the setting along with the patch row.
  // Set `enablePluginMcp: false` to keep plugin MCP servers off.
  enablePluginMcp: z.boolean().default(true),
  // Print a one-shot "star it" nudge on the first activation (default true).
  enableStarNudge: z.boolean().default(true),
});

const STAR_URL = 'https://github.com/biedongbin/dsh-claude-compat';
// Module-level once-flag: nudge exactly once per process, on the first profile
// that activates the plugin, so it never repeats across restarts of the same
// session. Deliberately NOT persistent — a fresh process nudges again, which
// is the intended "did this help? star it" cadence without spamming.
let starNudged = false;

// Body of the reload-cc-plugins / reload-skills skills. Inline skill bodies
// travel in the locator (`{ kind: 'inline', body }`) — the DSH registry loads
// definitions exclusively through `provider.get(candidate)`, so the body must
// be reachable from the candidate itself, never from a closure or disk.
const RELOAD_BODY = `# Catalog reloaded ✅

The DSH skill catalog cache was just dropped and observers notified.
Freshly installed/removed skills are now visible in this session (the skill
picker refreshes automatically on the next catalog read).

Notes:
- New skills from \`/plugin install\` or edits under \`.claude\` are live now.
- MCP servers shipped by plugins still require a DSH restart (process-lifetime mount).
- \`/reload-cc-plugins\` and \`/reload-skills\` are aliases.`;

export function apply(ctx, config = {}) {
  // One-shot "found this useful? star it" nudge, surfaced exactly where the
  // value lands: the first profile activation of this process.
  try {
    if (config.enableStarNudge !== false && !starNudged) {
      starNudged = true;
      console.log(
        `\n⭐ dsh-claude-compat works for you?\n   Show some love: ${STAR_URL}\n`);
    }
  } catch { /* the nudge must never break plugin activation */ }

  if (config.enableSkills !== false) {
    let provider;
    ctx.skills.registerProvider((control) => {
      provider = new ClaudeCompatSkillProvider(ctx, control, config);
      return provider;
    });
    // Native human commands (host-executed, zero model tokens; see
    // src/commands.js). The manager skills stay model-invocable as the
    // fallback surface; the human entry point becomes the command. Needs the
    // provider reference for reload invalidation.
    if (config.enablePluginManager !== false) {
      registerManagerCommands(ctx, config, () => provider);
    }
  }
  if (config.enableRules !== false) {
    registerRulesSection(ctx, config);
  }
  if (config.enableHooks !== false) {
    registerHooks(ctx, config);
  }
  if (config.enableMcp !== false) {
    mountMcpForWorkspace(ctx, config, process.cwd()).catch((error) => {
      console.warn('dsh-claude-compat: MCP mount failed:', error?.message ?? error);
    });
  }
}

// One-shot guard: a DSH host normally starts in a profile directory, so the
// launch workspace has no project root. The first session then supplies the
// real workspace and the project/user/local scopes mount from there — instead
// of silently mounting nothing.
let mcpSessionFallbackUsed = false;
const mcpSessionMounted = new Set();

/**
 * Mount the MCP servers that apply to `cwd`, then the plugin-provided ones.
 *
 * Sequential on purpose: Claude Code's scope precedence (local > project > user
 * > plugin) decides a name collision, not whichever async mount finished first.
 */
async function mountMcpForWorkspace(ctx, config, cwd) {
  const result = await mountMcpServers(ctx, config, { cwd });
  if (result.projectRoot === undefined && !mcpSessionFallbackUsed) {
    mcpSessionFallbackUsed = true;
    ctx.on('agent/created', (carrier, name, payload) => {
      const agent = carrier?.agent ?? payload?.agent;
      const sessionCwd = agent?.session?.header?.cwd;
      if (typeof sessionCwd !== 'string' || sessionCwd.length === 0) return;
      if (mcpSessionMounted.has(sessionCwd)) return;
      mcpSessionMounted.add(sessionCwd);
      mountMcpForWorkspace(ctx, config, sessionCwd).catch((error) => {
        console.warn('dsh-claude-compat: MCP mount for session workspace failed:', error?.message ?? error);
      });
    });
  }
  if (config.enablePlugins !== false && config.enablePluginMcp === true) {
    await mountPluginMcp(ctx, config);
  }
  return result;
}

// Translate every installed plugin's MCP config and mount alongside the
// higher-precedence scopes. A plugin without a readable manifest is still
// scanned (its conventional `<installPath>/.mcp.json` is what most ship).
async function mountPluginMcp(ctx, config) {
  for (const plugin of readInstalledClaudePlugins(config.pluginsRoot)) {
    const raw = await readTextSafe(join(plugin.installPath, '.claude-plugin', 'plugin.json'));
    let manifest = {};
    if (raw !== undefined) {
      try { manifest = JSON.parse(raw) ?? {}; } catch { manifest = {}; }
    }
    const { servers, warns } = translatePluginMcp(manifest, plugin.installPath, {
      failOnStartupError: config.mcpFailOnStartupError ?? false,
      // Claude Code namespaces plugin servers (`plugin_<plugin>_<server>`) so
      // permission rules and hook matchers written for it keep matching.
      pluginName: plugin.name,
    });
    warns.forEach((w) => console.warn(`dsh-claude-compat: plugin ${plugin.key}: ${w}`));
    if (servers.length > 0) await mountMcpConfigs(ctx, servers);
  }
}

// ─── skill provider ──────────────────────────────────────────────────────────

class ClaudeCompatSkillProvider {
  constructor(ctx, control, config) {
    this.ctx = ctx;
    this.name = 'claude-compat';
    this.config = config;
    this.skillRank = config.skillRank ?? 50;
    this.source = config.skillSource ?? 'project-claude';
    this.userSkillRank = config.userSkillRank ?? 700;
    this.userSkillSource = config.userSkillSource ?? 'user-claude';
    this.userClaudeDir = resolveUserClaudeDir(config.userClaudeDir);
    this.aliases = normalizeAliases(config.skillAliases);
    this.aliasOptions = {
      aliases: this.aliases,
      tagOriginal: config.aliasDescriptionPrefix !== false,
    };
    this.control = control;
    control.signal.addEventListener('abort', () => {}, { once: true });
  }

  async list(options) {
    const cwd = options?.cwd;
    const candidates = [];
    // Project .claude needs a cwd to locate the project root; user ~/.claude
    // is cwd-independent (mirrors DSH's own user-dsh/user-agents roots, which
    // are scanned unconditionally).
    if (cwd !== undefined && cwd !== null) {
      // findProjectRoot falls back to cwd when no marker is found, so a plain
      // (non-git) working directory still contributes <cwd>/.claude.
      const projectRoot = await findProjectRoot(cwd, this.config.projectRootMarkers);
      if (projectRoot !== undefined) {
        await this.addRootCandidates(candidates, join(projectRoot, '.claude'), this.source, this.skillRank);
      }
    }
    await this.addRootCandidates(candidates, this.userClaudeDir, this.userSkillSource, this.userSkillRank);
    if (this.config.enablePluginManager !== false) {
      candidates.push(this.managerSkillCandidate('cc-plugin',
        'Manage Claude Code plugins and marketplaces: list, install, uninstall, enable, disable, update, search.',
        'User wants to install, list, enable/disable, update, or uninstall Claude Code plugins, or manage plugin marketplaces. Usage: /cc-plugin, /cc-plugin <name>[@marketplace], /cc-plugin install|uninstall|enable|disable|update|search ..., /cc-plugin marketplace list|add|remove|update.',
        (await import('./plugin-manager.js')).PLUGIN_SKILL_BODY));
      candidates.push(this.reloadSkillDef('reload-cc-plugins',
        'Hot-reload the skill catalog: pick up newly installed/removed Claude Code plugin skills without a new session.'));
      candidates.push(this.reloadSkillDef('reload-skills',
        'Hot-reload the skill catalog (alias of /reload-cc-plugins).'));
      candidates.push(this.managerSkillCandidate('cc-resume',
        'List and import Claude Code sessions into DSH: browse ~/.claude/projects history and resume any conversation.',
        'User wants to resume, list, or import a Claude Code conversation/session into DSH. Usage: /cc-resume list, /cc-resume import <sessionId>.',
        (await import('./cc-resume-skill.mjs')).CC_RESUME_SKILL_BODY));
      candidates.push(this.managerSkillCandidate('cc-export',
        'Export DSH-native skills (.dsh/skills) into Claude Code .claude/skills format, closing the DSH → Claude loop.',
        'User wants to export DSH skills to Claude Code, or bridge DSH-native skills into .claude/skills. Usage: /cc-export list, /cc-export export [--overwrite].',
        (await import('./cc-export-skill.mjs')).CC_EXPORT_SKILL_BODY));
    }
    if (this.config.enablePlugins !== false) {
      const pluginCandidates = await discoverPluginContent(
        this.config.pluginsRoot, this.name, this.config.pluginSkillSource ?? 'claude-plugin',
        this.config.pluginSkillRank ?? 750,
        { enableAgents: this.config.enableAgents, ...this.aliasOptions });
      candidates.push(...pluginCandidates);
    }
    return candidates;
  }

  // Invalidate fires when the definition is actually loaded (get()), not at
  // list() time — loading the reload skill IS the reload.
  reloadSkillDef(name, description) {
    return this.managerSkillCandidate(name, description, undefined, RELOAD_BODY, { invalidate: true });
  }

  managerSkillCandidate(name, description, whenToUse, body, { invalidate = false } = {}) {
    return {
      name,
      description,
      ...(whenToUse !== undefined ? { whenToUse } : {}),
      // Human entry is the native command (src/commands.js); keep the skill
      // model-invocable so the model can still load these instructions, but
      // out of the user's slash menu to avoid a double entry.
      invocation: { modelInvocable: true, userInvocable: false },
      provider: this.name,
      source: 'claude-compat-manager',
      rank: this.config.pluginManagerRank ?? 40,
      // kind: 'inline' makes provider.get() serve `body` directly instead of
      // reading a path from disk. No `path` — import.meta.url is a file:// URL
      // and the module source is not the skill body.
      locator: { kind: 'inline', body, invalidate },
    };
  }

  async addRootCandidates(candidates, claudeDir, source, rank) {
    const provider = this.name;
    const tasks = [discoverSkills(join(claudeDir, 'skills'), provider, source, rank, this.aliasOptions)];
    for (const [dir, fn] of [
      ['commands', discoverCommands],
      ['agents', discoverAgents],
    ]) {
      if (dir === 'agents' && this.config.enableAgents === false) continue;
      tasks.push(fn(join(claudeDir, dir), provider, source, rank, this.aliasOptions));
    }
    const batches = await Promise.all(tasks);
    for (const batch of batches) candidates.push(...batch);
  }

  async get(candidate) {
    const locator = candidate.locator;
    if (locator?.kind === 'inline') {
      // Inline manager skills (cc-plugin, reload-*, cc-resume, cc-export):
      // the body ships in the locator. Loading a reload skill IS the reload —
      // drop the catalog cache so the next list() recollects fresh state.
      // (Not in list(): that would fire on every catalog collection and
      // defeat the cache entirely.)
      if (locator.invalidate) {
        try { this.control?.invalidate?.(); } catch { /* best-effort */ }
        // Hook configs are cached per workspace; a reload must pick up newly
        // installed plugins and edited settings files too.
        try { invalidateHookCache(); } catch { /* best-effort */ }
      }
      return {
        name: candidate.name,
        description: candidate.description,
        ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
        invocation: candidate.invocation,
        source: candidate.source,
        provider: this.name,
        content: locator.body,
      };
    }
    const raw = await readTextSafe(locator.path);
    if (raw === undefined) return undefined;
    const parsed = parseFrontmatter(raw);
    let content;
    if (candidate.agentTools !== undefined) {
      // Agent-backed candidate: lead the body with the delegation instruction.
      content = renderAgentContent(candidate, (parsed?.body ?? raw).trim());
    } else {
      content = parsed === undefined ? raw.trim() : parsed.body.trim();
    }
    if (candidate.hasArguments === true) {
      content = `${argumentsNotice(candidate.argumentHint)}\n\n${content}`;
    }
    return {
      name: candidate.name,
      description: candidate.description,
      ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
      invocation: candidate.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      content,
    };
  }
}

// ─── discovery: <root>/.claude/skills (recursive, ≤3 levels) ─────────────────

export async function discoverSkills(rootDir, providerName, source, rank, aliasOptions) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  if (!(await pathExistsSafe(rootDir))) return out;
  await walk(rootDir, '', 0);
  return out;

  async function walk(dir, prefix, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch { return; }
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
      const skillPath = join(dir, 'SKILL.md');
      const c = await parseSkillCandidateFile(
        skillPath, providerName, source, rank, prefix || undefined, aliasOptions);
      if (c !== undefined) out.push(c);
      return; // bundle — don't descend
    }
    if (depth >= 3) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      const childPrefix = prefix ? `${prefix}-${entry.name}` : entry.name;
      await walk(join(dir, entry.name), childPrefix, depth + 1);
    }
  }
}

// ─── discovery: <root>/.claude/commands (flat) ───────────────────────────────

export async function discoverCommands(rootDir, providerName, source, rank, aliasOptions) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  if (!(await pathExistsSafe(rootDir))) return out;
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true, encoding: 'utf8' });
  } catch { return out; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(rootDir, entry.name);
    const stem = entry.name.slice(0, -3);
    const resolved = resolveCandidateName([stem], aliasOptions?.aliases);
    if (resolved === undefined) {
      warnUnmapped('command', stem, path);
      continue;
    }
    const raw = await readTextSafe(path);
    if (raw === undefined) continue;
    const parsed = parseFrontmatter(raw);
    const data = parsed?.data ?? {};
    let invocation;
    try {
      invocation = parsed === undefined ? { modelInvocable: true, userInvocable: true } : parseInvocationPolicy(data);
    } catch {
      invocation = { modelInvocable: true, userInvocable: true };
    }
    const argumentHint = stringField(data, 'argument-hint');
    const baseDescription = parsed === undefined ? stem : (stringField(data, 'description') ?? stem);
    out.push({
      name: resolved.name,
      description: aliasOptions?.tagOriginal === false
        ? (argumentHint === undefined ? baseDescription : `${baseDescription} (args: ${argumentHint})`)
        : withOriginalName(argumentHint === undefined ? baseDescription : `${baseDescription} (args: ${argumentHint})`, resolved.original),
      invocation,
      // DSH's skill tool has no argument channel, so a command body that uses
      // `$ARGUMENTS`/`$1` cannot be filled in. Mark the candidate so get() can
      // tell the model where to read the arguments instead of leaking the
      // literal placeholder into the instructions.
      ...(/\$ARGUMENTS|\$[0-9]/.test(raw) ? { hasArguments: true, argumentHint } : {}),
      provider: providerName,
      source,
      rank,
      locator: { path, directory: rootDir },
      resourceBase: { kind: 'directory', path: rootDir },
      path,
    });
  }
  return out;
}

async function parseSkillCandidateFile(path, providerName, source, rank, flatName, aliasOptions) {
  const raw = await readTextSafe(path);
  if (raw === undefined) return undefined;
  const parsed = parseFrontmatter(raw);
  const fmName = parsed === undefined ? undefined : stringField(parsed.data, 'name');
  const body = parsed === undefined ? raw : parsed.body;
  // Claude Code loads a skill without a description (it falls back to the body),
  // so dropping it here silently removed real skills.
  const description = (parsed === undefined ? undefined : stringField(parsed.data, 'description'))
    ?? firstBodyLine(body)
    ?? fmName
    ?? flatName;
  if (description === undefined) return undefined;
  // Prefer frontmatter name when it is a valid kebab-case skill name. Some Claude
  // skills use names with ':' or other chars DSH rejects (e.g.
  // "salus:ai-robot-coding-env-check"); for those, fall back to the flattened
  // directory name, which is virtually always kebab-case. Names that are not
  // kebab-case at all (e.g. Chinese) can still be surfaced through an explicit
  // `skillAliases` mapping — see src/aliases.js.
  const resolved = resolveCandidateName([fmName, flatName], aliasOptions?.aliases);
  if (resolved === undefined) {
    warnUnmapped('skill', fmName ?? flatName ?? path, path);
    return undefined;
  }
  let invocation;
  try { invocation = parseInvocationPolicy(parsed.data); }
  catch { invocation = { modelInvocable: true, userInvocable: true }; }
  // Claude Code writes `when_to_use` (snake_case) in frontmatter; the camelCase
  // spelling was the only one read, so the field silently never applied.
  const whenToUse = stringField(parsed?.data ?? {}, 'when_to_use') ?? stringField(parsed?.data ?? {}, 'whenToUse');
  return {
    name: resolved.name,
    description: aliasOptions?.tagOriginal === false
      ? description
      : withOriginalName(description, resolved.original),
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    invocation,
    provider: providerName,
    source,
    rank,
    locator: { path, directory: dirname(path) },
    resourceBase: { kind: 'directory', path: dirname(path) },
    path,
  };
}

// ─── rules section ───────────────────────────────────────────────────────────

function registerRulesSection(ctx, config) {
  const maxBytes = config.rulesMaxBytes ?? 65536;
  // Cache built messages per session cwd — building reads ~13 files, and
  // pre-step fires every step.
  const cache = new Map();
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const present = (list) => list.some((m) => m?.source?.kind === CLAUDE_COMPAT_SOURCE_KIND);
    // dsh 0.1.2 made the event log private — exact lookup is eventAt(seq),
    // the same API dsh core uses for its own surface scans. Legacy dsh
    // exposed a plain session.events array; keep an optional fallback.
    const alreadyInjected = present(messages)
      || present(decision.messages)
      || agent.session.surface.nodes.some((seq) => {
        const event = agent.session.eventAt?.(seq) ?? agent.session.events?.[seq];
        return event?.type === 'user/message'
          && event.data?.source?.kind === CLAUDE_COMPAT_SOURCE_KIND;
      });
    if (alreadyInjected) return decision;
    // Session cwd, NOT process.cwd() — the DSH process may be launched from
    // anywhere (e.g. the profile dir); the workspace is per-session. Same
    // source of truth as dsh-agent-instructions.
    const cwd = agent.session.header?.cwd ?? process.cwd();
    if (!cache.has(cwd)) {
      const text = buildRulesText(cwd, config, maxBytes);
      if (text.length === 0) return decision;
      // Claude Code's mechanism (leaked source, api.ts prependUserContext):
      // rules as ONE user-role <system-reminder> message at the very front
      // of the message array. Not in system prompt.
      cache.set(cwd, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: CLAUDE_COMPAT_SOURCE_KIND, form: 'rules' },
      }));
    }
    return {
      kind: 'enter',
      messages: decision.messages.toSpliced(0, 0, cache.get(cwd)),
    };
  });
}

function buildRulesText(cwd, config, maxBytes) {
  const parts = [];
  const seen = new Set();
  const pushRoot = (rootDir, cap) => {
    let remaining = cap;
    const files = listMdFilesSync(rootDir);
    for (const f of files) {
      const basename = f.split('/').pop();
      if (seen.has(basename)) continue; // higher-priority root already included
      let raw;
      try { raw = readFileSync(f, 'utf8'); } catch { continue; }
      const chunk = `## ${basename}\n\n${raw.trim()}\n`;
      if (chunk.length > remaining) break;
      remaining -= chunk.length;
      seen.add(basename);
      parts.push(chunk);
    }
  };
  // Project .claude/rules first: wins same-name collisions against ~/.claude.
  // findProjectRootSync falls back to cwd when no marker is found, so rules also
  // load from a working directory that is not a git repository.
  const projectRoot = findProjectRootSync(cwd, config.projectRootMarkers);
  if (projectRoot !== undefined) {
    pushRoot(join(projectRoot, '.claude', 'rules'), maxBytes);
  }
  pushRoot(join(resolveUserClaudeDir(config.userClaudeDir), 'rules'), config.userRulesMaxBytes ?? maxBytes);
  if (parts.length === 0) return '';
  // Exact envelope Claude Code uses in prependUserContext (api.ts):
  // user-role <system-reminder> with "# claudeMd" framing.
  return `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
${parts.join('\n')}
      </system-reminder>`;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function pathExistsSafe(path) {
  try { await stat(path); return true; } catch { return false; }
}

function parseInvocationPolicy(data) {
  const miv = data['disable-model-invocation'];
  const uiv = data['user-invocable'];
  return {
    modelInvocable: !truthy(miv),
    userInvocable: uiv === undefined ? true : truthy(uiv),
  };
}

/** First non-empty line of a markdown body, used as a description fallback. */
function firstBodyLine(body) {
  if (typeof body !== 'string') return undefined;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === '---') continue;
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
  return undefined;
}

/**
 * DSH's skill tool takes only a name, so a Claude Code command's `$ARGUMENTS`
 * placeholders cannot be substituted. Rather than leaking the literal token,
 * the body is prefixed with where the arguments actually are.
 */
function argumentsNotice(argumentHint) {
  const hint = typeof argumentHint === 'string' && argumentHint.length > 0
    ? `Expected arguments: ${argumentHint}.`
    : 'This command expects arguments.';
  return `> **Arguments**: ${hint} Write them in your message after the command; `
    + 'any `$ARGUMENTS` / `$1` placeholders below refer to that text. '
    + 'If the message carries none, ask for them instead of guessing.';
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    return s === 'true' || s === 'yes' || s === 'on' || s === '1';
  }
  if (typeof v === 'number') return v !== 0;
  return false;
}