// v1.0.2 regression tests: plugin MCP discovery honoured only a `mcpServers`
// path string in the plugin manifest, so a plugin that keeps its servers in the
// conventional `<installPath>/.mcp.json` (claude-mem) or inline in the manifest
// contributed zero MCP servers — silently. `translatePluginMcp()` now accepts
// all three Claude Code shapes and reports malformed input instead of ignoring it.
//
// Hermetic: temp directories only, no network, no DSH peers, no claude binary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { translatePluginMcp } from '../src/plugins.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'ccc-v102-')));

function pluginDir(files) {
  const dir = tmp();
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const MCP_JSON = {
  mcpServers: {
    'mcp-search': { type: 'stdio', command: 'node', args: ['-e', 'console.log(1)'] },
  },
};

test('absent manifest mcpServers falls back to <installPath>/.mcp.json (claude-mem layout)', () => {
  const dir = pluginDir({ '.mcp.json': MCP_JSON, '.claude-plugin/plugin.json': { name: 'claude-mem' } });
  const { servers, warns } = translatePluginMcp({ name: 'claude-mem', version: '13.34.2' }, dir);
  assert.equal(warns.length, 0);
  assert.deepEqual(servers.map((s) => s.serverName), ['mcp-search']);
  assert.equal(servers[0].transport, 'stdio');
  assert.equal(servers[0].command, 'node');
});

test('a plugin with no MCP config anywhere yields no servers and no warnings', () => {
  const dir = pluginDir({ '.claude-plugin/plugin.json': { name: 'plain' } });
  const { servers, warns } = translatePluginMcp({ name: 'plain' }, dir);
  assert.deepEqual(servers, []);
  assert.deepEqual(warns, [], 'absence of MCP is not a problem — stay quiet');
});

test('inline manifest mcpServers object is translated', () => {
  const dir = pluginDir({ '.claude-plugin/plugin.json': { name: 'inline' } });
  const { servers, warns } = translatePluginMcp({
    name: 'inline',
    mcpServers: { search: { command: 'node', args: ['srv.js'], env: { TOKEN: 'x' } } },
  }, dir);
  assert.deepEqual(warns, []);
  assert.deepEqual(servers.map((s) => s.serverName), ['search']);
  // The plugin root is exposed to the child process as well: several plugins
  // (claude-mem) read process.env.CLAUDE_PLUGIN_ROOT instead of relying on
  // `${...}` substitution inside their own command strings.
  assert.deepEqual(servers[0].env, { TOKEN: 'x', CLAUDE_PLUGIN_ROOT: dir });
});

test('a path string still wins over the conventional file', () => {
  const dir = pluginDir({
    'custom/mcp.json': { mcpServers: { fromCustom: { command: 'node' } } },
    '.mcp.json': { mcpServers: { fromConventional: { command: 'node' } } },
  });
  const { servers } = translatePluginMcp({ name: 'p', mcpServers: './custom/mcp.json' }, dir);
  assert.deepEqual(servers.map((s) => s.serverName), ['fromCustom']);
});

test('${CLAUDE_PLUGIN_ROOT} is substituted in the conventional file too', () => {
  const dir = pluginDir({
    '.mcp.json': { mcpServers: { local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/srv.js'] } } },
  });
  const { servers } = translatePluginMcp({ name: 'p' }, dir);
  assert.deepEqual(servers[0].args, [join(dir, 'srv.js')]);
});

test('an unreadable mcpServers path warns instead of vanishing', () => {
  const dir = pluginDir({ '.claude-plugin/plugin.json': { name: 'p' } });
  const { servers, warns } = translatePluginMcp({ name: 'p', mcpServers: './missing.json' }, dir);
  assert.deepEqual(servers, []);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /not readable/);
});

test('a malformed mcpServers value warns instead of vanishing', () => {
  const dir = pluginDir({ '.claude-plugin/plugin.json': { name: 'p' } });
  for (const bad of [[1, 2], 42, null]) {
    const { servers, warns } = translatePluginMcp({ name: 'p', mcpServers: bad }, dir);
    assert.deepEqual(servers, []);
    assert.equal(warns.length, 1, `mcpServers=${JSON.stringify(bad)} should warn`);
    assert.match(warns[0], /expected an object or a path string/);
  }
});

test('an explicit empty inline map is authoritative: no servers, no warnings', () => {
  const dir = pluginDir({ '.mcp.json': MCP_JSON });
  const { servers, warns } = translatePluginMcp({ name: 'p', mcpServers: {} }, dir);
  assert.deepEqual(servers, [], 'an explicit empty map means "this plugin ships none"');
  assert.deepEqual(warns, [], 'and it does not fall back to .mcp.json either');
});
