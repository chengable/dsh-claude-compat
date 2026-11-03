// v1.1.0: MCP coverage — the gaps the audit found in the old translation layer.
//
//   - `${VAR}` / `${VAR:-default}` / ${CLAUDE_PROJECT_DIR} / ${CLAUDE_PLUGIN_ROOT}
//     expansion, with Claude Code's remote-credential guard,
//   - `timeout`, `disabled`, and the transports DSH does not have (`ws`, `sdk`;
//     legacy `sse` mounted with a warning),
//   - scope precedence: local (~/.claude.json projects[path]) > project
//     (.mcp.json) > user (~/.claude.json mcpServers),
//   - plugin server namespacing (`plugin_<plugin>_<server>`), so permission
//     rules written for Claude Code keep matching,
//   - server-name truncation that cannot collide.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  collectMcpSources,
  expandEnvVars,
  mergeMcpSources,
  pluginServerName,
  sanitizeServerName,
  translateMcpServers,
} from '../src/mcp.js';
import { translatePluginMcp } from '../src/plugins.js';

function sandbox(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function config(body) {
  return JSON.stringify({ mcpServers: body });
}

// ─── variable expansion ────────────────────────────────────────────────────

test('expandEnvVars: ${VAR}, ${VAR:-default}, the Claude placeholders and unknown names', () => {
  const env = { TOKEN: 'abc', EMPTY: '' };
  assert.equal(expandEnvVars('Bearer ${TOKEN}', { env }), 'Bearer abc');
  assert.equal(expandEnvVars('${MISSING:-fallback}', { env }), 'fallback');
  // A variable set to the empty string counts as set, so the default is not used.
  assert.equal(expandEnvVars('${EMPTY:-fallback}', { env }), '');
  // Unknown without a default stays literal, so a missing token is visible.
  assert.equal(expandEnvVars('${MISSING}', { env }), '${MISSING}');
  assert.equal(expandEnvVars('${CLAUDE_PROJECT_DIR}/srv.js', { env, projectDir: '/proj' }), '/proj/srv.js');
  assert.equal(expandEnvVars('${CLAUDE_PLUGIN_ROOT}/srv.js', { env, pluginRoot: '/plug' }), '/plug/srv.js');
});

test('expandEnvVars: remote strings blank the credentials Claude Code hides', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-secret', MY_TOKEN: 'mine' };
  // A project .mcp.json must not be able to exfiltrate the machine's keys.
  assert.equal(expandEnvVars('Bearer ${ANTHROPIC_API_KEY}', { env, remote: true }), 'Bearer ');
  // Ordinary variables still expand remotely.
  assert.equal(expandEnvVars('Bearer ${MY_TOKEN}', { env, remote: true }), 'Bearer mine');
});

// ─── naming ────────────────────────────────────────────────────────────────

test('server names: plugin namespacing and collision-free truncation', () => {
  assert.equal(pluginServerName('claude-mem', 'mcp-search'), 'plugin_claude-mem_mcp-search');
  assert.equal(pluginServerName('my plugin!', 'search'), 'plugin_my_plugin__search');

  const long = 'a'.repeat(40);
  const other = `${'a'.repeat(39)}b`;
  const first = sanitizeServerName(long);
  const second = sanitizeServerName(other);
  assert.ok(first.length <= 32);
  assert.ok(second.length <= 32);
  assert.notEqual(first, second, 'two long names must not truncate to the same serverName');
});

// ─── translation ───────────────────────────────────────────────────────────

test('translateMcpServers: timeout, disabled, and unsupported transports', () => {
  const { servers, warns } = translateMcpServers(config({
    slow: { command: 'node', timeout: 600000 },
    off: { command: 'node', disabled: true },
    ws: { type: 'ws', url: 'wss://example.com/mcp' },
    sdk: { type: 'sdk', url: 'https://example.com/mcp' },
    legacy: { type: 'sse', url: 'https://example.com/sse' },
    untyped: { url: 'https://example.com/mcp' },
  }), { env: {} });

  const byName = new Map(servers.map((s) => [s.serverName, s]));
  assert.equal(byName.get('slow').toolCallTimeoutMs, 600000, 'the Claude Code timeout is honored');
  assert.equal(byName.has('off'), false, 'disabled servers are skipped');
  assert.equal(byName.has('ws'), false, 'WebSocket has no DSH transport');
  assert.equal(byName.has('sdk'), false, 'sdk servers are skipped like Claude Code does');
  assert.equal(byName.get('legacy').transport, 'streamable-http');
  assert.ok(warns.some((w) => w.includes('SSE')), 'legacy SSE warns');
  assert.equal(byName.get('untyped').transport, 'streamable-http');
  assert.ok(warns.some((w) => w.includes('without a type')), 'url without type warns');
});

test('translateMcpServers: expands command/args/env/url/headers and resolves cwd', () => {
  const env = { TOKEN: 'tok', ROOT: '/srv' };
  const { servers } = translateMcpServers(config({
    local: {
      command: '${ROOT}/bin/server',
      args: ['--token', '${TOKEN}'],
      env: { A: '${TOKEN}' },
      cwd: './sub',
    },
    remote: {
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' },
    },
  }), { env, projectDir: '/proj' });

  const local = servers.find((s) => s.serverName === 'local');
  assert.equal(local.command, '/srv/bin/server');
  assert.deepEqual(local.args, ['--token', 'tok']);
  assert.equal(local.env.A, 'tok');
  assert.equal(local.cwd, '/proj/sub', 'relative cwd resolves against the project root');
  const remote = servers.find((s) => s.serverName === 'remote');
  assert.deepEqual(remote.headers, { Authorization: 'Bearer tok' });
});

// ─── scopes and precedence ─────────────────────────────────────────────────

test('collectMcpSources: local (~/.claude.json projects[path]) beats project, project beats user', () => {
  const home = sandbox('dcc-mcp-home-');
  const project = sandbox('dcc-mcp-proj-');
  mkdirSync(join(project, '.git'));
  writeJson(join(project, '.mcp.json'), { mcpServers: {
    shared: { command: 'project-command' },
    'project-only': { command: 'p' },
  } });
  writeJson(join(home, '.claude.json'), {
    mcpServers: { shared: { command: 'user-command' }, 'user-only': { command: 'u' } },
    projects: {
      [project]: { mcpServers: { shared: { command: 'local-command' } } },
    },
  });

  const { projectRoot, sources } = collectMcpSources({
    cwd: project,
    config: { userClaudeDir: join(home, '.claude') },
  });
  assert.equal(projectRoot, project);
  assert.deepEqual(sources.map((s) => s.scope).filter((s) => s !== 'local-disabled'), ['local', 'project', 'user']);

  const { servers } = mergeMcpSources(sources);
  const byName = new Map(servers.map((s) => [s.serverName, s.command]));
  assert.equal(byName.get('shared'), 'local-command', 'local scope wins the whole entry');
  assert.equal(byName.get('project-only'), 'p');
  assert.equal(byName.get('user-only'), 'u');
});

test('mergeMcpSources: ~/.claude.json disabledMcpServers removes the server', () => {
  const project = sandbox('dcc-mcp-dis-');
  mkdirSync(join(project, '.git'));
  writeJson(join(project, '.mcp.json'), { mcpServers: { keep: { command: 'k' }, drop: { command: 'd' } } });
  const { servers } = mergeMcpSources([{
    scope: 'project', label: 'p', servers: [{ serverName: 'keep' }, { serverName: 'drop' }],
    warns: [], disabled: ['drop'],
  }]);
  assert.deepEqual(servers.map((s) => s.serverName), ['keep']);
});

// ─── plugin MCP ────────────────────────────────────────────────────────────

test('translatePluginMcp: namespaces servers, substitutes the root, and injects the env var', () => {
  const installPath = sandbox('dcc-mcp-plugin-');
  writeJson(join(installPath, '.mcp.json'), { mcpServers: {
    search: { command: '${CLAUDE_PLUGIN_ROOT}/bin/srv', env: { KEEP: '1' } },
  } });
  const { servers, warns } = translatePluginMcp(
    { name: 'claude-mem' }, installPath, { pluginName: 'claude-mem' });
  assert.deepEqual(warns, []);
  assert.equal(servers[0].serverName, 'plugin_claude-mem_search');
  assert.equal(servers[0].command, `${installPath}/bin/srv`);
  assert.equal(servers[0].env.CLAUDE_PLUGIN_ROOT, installPath);
  assert.equal(servers[0].env.KEEP, '1');
});

test('translatePluginMcp: a plugin without a readable manifest still contributes its .mcp.json', () => {
  const installPath = sandbox('dcc-mcp-nomanifest-');
  writeJson(join(installPath, '.mcp.json'), { mcpServers: { srv: { command: 'node' } } });
  const { servers } = translatePluginMcp({}, installPath);
  assert.deepEqual(servers.map((s) => s.serverName), ['srv']);
});
