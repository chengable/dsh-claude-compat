// dsh-claude-compat: Claude Code MCP servers, translated onto
// @deepseek-ai/dsh-mcp-client plugin instances.
//
// Sources and precedence (Claude Code's own hierarchy, highest first):
//
//   local    ~/.claude.json → projects[<abs path>].mcpServers   (`claude mcp add` default)
//   project  <projectRoot>/.mcp.json
//   user     ~/.claude.json → mcpServers
//   plugin   <installPath>/.mcp.json or the manifest's mcpServers (lowest)
//
// A higher scope wins the whole entry on a name collision (Claude Code never
// merges fields across scopes). Tool names then match Claude Code's shape:
// `mcp__<server>__<tool>`, and plugin servers are namespaced as
// `plugin_<plugin>_<server>` so permission rules and hook matchers written for
// Claude Code keep matching.
//
// Failure handling stays non-fatal: an unreadable/malformed config or an absent
// dsh-mcp-client package logs and skips, never crashing the harness.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import {
  findProjectRootSync,
  pathExists,
  resolveUserClaudeDir,
} from './lib.js';

// ─── variable expansion ─────────────────────────────────────────────────────

/**
 * Credentials Claude Code deliberately reads as EMPTY for remote (url/headers)
 * servers: a project's `.mcp.json` must not be able to exfiltrate the machine's
 * keys to a remote endpoint. Expansion of remote strings keeps the same guard.
 */
const REMOTE_CREDENTIAL_VARS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand `${VAR}` and `${VAR:-default}` plus the Claude placeholders.
 *
 * Unknown variables keep their literal form (Claude Code warns and passes the
 * text through, which is what makes a missing token visible instead of silently
 * becoming an empty string). A variable that IS set to the empty string counts
 * as set, so `${VAR:-fallback}` yields `''`.
 */
export function expandEnvVars(value, { env = process.env, projectDir, pluginRoot, pluginData, remote = false } = {}) {
  if (typeof value !== 'string') return value;
  const special = {
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: pluginData,
  };
  return value.replace(VAR_PATTERN, (match, name, fallback) => {
    if (remote && REMOTE_CREDENTIAL_VARS.has(name)) return '';
    if (Object.prototype.hasOwnProperty.call(special, name) && special[name] !== undefined) {
      return special[name];
    }
    if (Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined) {
      return String(env[name]);
    }
    return fallback !== undefined ? fallback : match;
  });
}

// ─── server naming ──────────────────────────────────────────────────────────

/** `plugin_<plugin>_<server>` with Claude Code's illegal characters replaced. */
export function pluginServerName(pluginName, serverKey) {
  const clean = (v) => String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
  return `${clean(pluginName)}_${clean(serverKey)}`;
}

/**
 * dsh-mcp-client requires /^[A-Za-z0-9_-]{1,32}$/. A plain slice makes two long
 * names collide (silently dropping the second), so a truncated name keeps a
 * short content hash to stay distinct.
 */
export function sanitizeServerName(name) {
  const clean = String(name ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (clean.length <= 32) return clean;
  const digest = createHash('sha256').update(clean).digest('hex').slice(0, 8);
  return `${clean.slice(0, 23)}_${digest}`;
}

function stringDict(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
  }
  return out;
}

// ─── translation ────────────────────────────────────────────────────────────

/**
 * Pure translation of a Claude Code MCP config body into dsh-mcp-client plugin
 * configs. Malformed entries are skipped and reported.
 *
 * `type` follows Claude Code: stdio by default, `http`/`streamable-http` for
 * URLs. Transports DSH does not have are reported: `ws` and `sdk` are skipped,
 * legacy `sse` is mounted as streamable-http with a warning (most SSE servers
 * accept the streamable endpoint too).
 */
export function translateMcpServers(rawJson, {
  failOnStartupError = false,
  env = process.env,
  projectDir,
  pluginRoot,
  pluginData,
  serverPrefix,
  toolCallTimeoutMs,
} = {}) {
  let parsed;
  try { parsed = JSON.parse(rawJson); }
  catch {
    return { servers: [], warns: [`invalid-json: ${String(rawJson).slice(0, 100)}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { servers: [], warns: ['invalid-json: root must be an object'] };
  }
  const servers = parsed.mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return { servers: [], warns: ['mcpServers: missing or not an object'] };
  }
  const out = [];
  const warns = [];
  const expandLocal = (v) => expandEnvVars(v, { env, projectDir, pluginRoot, pluginData });
  const expandRemote = (v) => expandEnvVars(v, { env, projectDir, pluginRoot, pluginData, remote: true });
  const timeoutOf = (entry) => {
    if (typeof entry.timeout === 'number' && entry.timeout > 0) return entry.timeout;
    if (toolCallTimeoutMs !== undefined) return toolCallTimeoutMs;
    const fromEnv = Number(env?.MCP_TOOL_TIMEOUT);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 60_000;
  };

  for (const [name, entry] of Object.entries(servers)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warns.push(`${name}: malformed entry, skipped`);
      continue;
    }
    // `disabled: true` is Claude Code's "/mcp" toggle.
    if (entry.disabled === true) {
      warns.push(`${name}: disabled, skipped`);
      continue;
    }
    const declared = typeof entry.type === 'string' ? entry.type : undefined;
    if (declared === 'sdk') {
      warns.push(`${name}: type 'sdk' is not supported by DSH, skipped`);
      continue;
    }
    if (declared === 'ws' || (typeof entry.url === 'string' && entry.url.startsWith('ws'))) {
      warns.push(`${name}: WebSocket transport is not supported by DSH, skipped`);
      continue;
    }
    const base = {
      serverName: sanitizeServerName(serverPrefix !== undefined ? pluginServerName(serverPrefix, name) : name),
      toolCallTimeoutMs: timeoutOf(entry),
      failOnStartupError,
    };
    if (base.serverName.length === 0) {
      warns.push(`${name}: empty server name, skipped`);
      continue;
    }
    if (typeof entry.command === 'string' && entry.command.length > 0) {
      const envDict = stringDict(entry.env);
      const expandedEnv = {};
      for (const [k, v] of Object.entries(envDict)) expandedEnv[k] = expandLocal(v);
      if (pluginRoot !== undefined && expandedEnv.CLAUDE_PLUGIN_ROOT === undefined) {
        // Claude Code exposes the plugin root to the child as an env var too;
        // several plugins (claude-mem) read process.env.CLAUDE_PLUGIN_ROOT.
        expandedEnv.CLAUDE_PLUGIN_ROOT = pluginRoot;
      }
      if (projectDir !== undefined && expandedEnv.CLAUDE_PROJECT_DIR === undefined) {
        expandedEnv.CLAUDE_PROJECT_DIR = projectDir;
      }
      out.push({
        ...base,
        transport: 'stdio',
        command: expandLocal(entry.command),
        args: Array.isArray(entry.args)
          ? entry.args.filter((a) => typeof a === 'string').map(expandLocal)
          : [],
        env: expandedEnv,
        // Relative cwd resolves against the project root, not the DSH process cwd.
        cwd: typeof entry.cwd === 'string' && entry.cwd.length > 0
          ? (isAbsolute(entry.cwd) ? entry.cwd : resolve(projectDir ?? process.cwd(), entry.cwd))
          : '',
      });
    } else if (typeof entry.url === 'string' && entry.url.length > 0) {
      if (declared === 'sse') {
        warns.push(`${name}: legacy SSE transport is unsupported by DSH; mounting as streamable-http`);
      }
      if (declared === undefined) {
        warns.push(`${name}: url without a type; treating it as streamable-http (Claude Code rejects this)`);
      }
      const headers = {};
      for (const [k, v] of Object.entries(stringDict(entry.headers))) headers[k] = expandRemote(v);
      out.push({
        ...base,
        transport: 'streamable-http',
        url: expandRemote(entry.url),
        headers,
      });
    } else if (declared === 'http' || declared === 'sse') {
      warns.push(`${name}: type '${declared}' without a url, skipped`);
    } else {
      warns.push(`${name}: neither command nor url, skipped`);
    }
  }
  return { servers: out, warns };
}

// ─── scope collection ───────────────────────────────────────────────────────

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/** `~/.claude.json` holds both the user and the local (per-project) MCP scopes. */
export function readUserClaudeJson(userClaudeDir) {
  const dir = resolveUserClaudeDir(userClaudeDir);
  // `~/.claude.json` sits beside `~/.claude/`, not inside it.
  const candidates = [join(dir, '..', '.claude.json'), join(dir, '.claude.json')];
  for (const path of candidates) {
    const parsed = readJson(path);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Ordered MCP sources for one workspace: local, project, user, plugin.
 * Each entry is `{ scope, label, servers, warns }`.
 */
export function collectMcpSources({ cwd, projectRoot, config = {} } = {}) {
  const sources = [];
  const root = projectRoot
    ?? findProjectRootSync(cwd ?? process.cwd(), config.projectRootMarkers ?? ['.git', 'CLAUDE.md']);
  const env = config.mcpEnv ?? process.env;
  const common = {
    failOnStartupError: config.mcpFailOnStartupError ?? false,
    env,
    projectDir: root,
  };

  const claudeJson = readUserClaudeJson(config.userClaudeDir);

  // 1) local scope: ~/.claude.json → projects[<abs path>].mcpServers
  if (claudeJson !== undefined && root !== undefined) {
    const entry = claudeJson.projects?.[root];
    const servers = entry?.mcpServers;
    if (typeof servers === 'object' && servers !== null && Object.keys(servers).length > 0) {
      const translated = translateMcpServers(JSON.stringify({ mcpServers: servers }), common);
      sources.push({ scope: 'local', label: `~/.claude.json projects[${root}]`, ...translated });
    }
    const disabled = Array.isArray(entry?.disabledMcpServers) ? entry.disabledMcpServers : [];
    if (disabled.length > 0) {
      sources.push({ scope: 'local-disabled', label: '~/.claude.json disabled', servers: [], warns: [], disabled });
    }
  }

  // 2) project scope: <projectRoot>/.mcp.json
  if (root !== undefined) {
    const path = join(root, '.mcp.json');
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch { raw = undefined; }
    if (raw !== undefined) {
      sources.push({ scope: 'project', label: path, ...translateMcpServers(raw, common) });
    }
  }

  // 3) user scope: ~/.claude.json → mcpServers
  if (claudeJson !== undefined && typeof claudeJson.mcpServers === 'object' && claudeJson.mcpServers !== null) {
    const translated = translateMcpServers(JSON.stringify({ mcpServers: claudeJson.mcpServers }), common);
    if (translated.servers.length > 0 || translated.warns.length > 0) {
      sources.push({ scope: 'user', label: '~/.claude.json mcpServers', ...translated });
    }
  }

  return { projectRoot: root, sources };
}

/** Apply Claude Code's scope precedence: a higher scope wins the whole entry. */
export function mergeMcpSources(sources) {
  const byName = new Map();
  const warns = [];
  for (const source of sources) {
    for (const w of source.warns ?? []) warns.push(`${source.label}: ${w}`);
    // Disabled lists from ~/.claude.json remove matching servers outright.
    const disabled = source.disabled ?? [];
    for (const server of source.servers ?? []) {
      if (disabled.includes(server.serverName)) continue;
      if (byName.has(server.serverName)) continue; // higher scope already claimed it
      byName.set(server.serverName, server);
    }
  }
  return { servers: [...byName.values()], warns };
}

// ─── mounting ───────────────────────────────────────────────────────────────

// Module-level: every mount path shares one dedupe set, so a project server and
// a plugin server that resolve to the same serverName cannot both mount (DSH
// rejects the second registration at runtime).
const mounted = new Set();

/** Reset the mount bookkeeping (tests, and a future unmount path). */
export function resetMountedServers() {
  mounted.clear();
}

/** Mount pre-translated server configs serially, skipping already-mounted names. */
export async function mountMcpConfigs(ctx, servers) {
  if (servers.length === 0) return { mounted: 0, skipped: 0 };
  let mcpClientModule;
  try {
    mcpClientModule = await import('@deepseek-ai/dsh-mcp-client');
  } catch (error) {
    console.warn('dsh-claude-compat: @deepseek-ai/dsh-mcp-client not installed', '(MCP disabled)', error?.message ?? error);
    return { mounted: 0, skipped: servers.length };
  }
  const mcpClient = mcpClientModule.default ?? mcpClientModule;
  let count = 0;
  let skipped = 0;
  for (const server of servers) {
    if (mounted.has(server.serverName)) {
      console.warn(`dsh-claude-compat: duplicate serverName "${server.serverName}" skipped (already mounted)`);
      skipped += 1;
      continue;
    }
    mounted.add(server.serverName);
    count += 1;
    // ctx.plugin returns a Fiber (PromiseLike) in real cordis; guard for
    // non-promise returns in tests/embeddings.
    const fiber = ctx.plugin(mcpClient, server);
    if (fiber && typeof fiber.catch === 'function') {
      fiber.catch((error) => {
        console.warn(`dsh-claude-compat: server "${server.serverName}" failed to mount: ${error?.message ?? error}`);
      });
    }
  }
  return { mounted: count, skipped };
}

/**
 * Collect and mount every MCP source for one workspace.
 *
 * `process.cwd()` is not a project in a DSH install (the host runs from the
 * profile directory), so the caller passes the session workspace. Without a
 * resolvable root the function reports that instead of returning silently —
 * the old behaviour made a project's whole `.mcp.json` vanish without a line.
 *
 * @returns `{ projectRoot, mounted, skipped, warnings }`.
 */
export async function mountMcpServers(ctx, config = {}, { cwd } = {}) {
  const workspace = cwd ?? process.cwd();
  const { projectRoot, sources } = collectMcpSources({ cwd: workspace, config });
  if (projectRoot === undefined) {
    console.warn(`dsh-claude-compat: no project root from "${workspace}" — project .mcp.json not mounted`);
  }
  const { servers, warns } = mergeMcpSources(sources);
  for (const w of warns) console.warn(`dsh-claude-compat: MCP: ${w}`);
  const result = await mountMcpConfigs(ctx, servers);
  if (result.mounted > 0) {
    console.log(`dsh-claude-compat: MCP: mounted ${result.mounted} server(s) from ${sources.length} source(s)`);
  }
  return { projectRoot, ...result, warnings: warns.length };
}
