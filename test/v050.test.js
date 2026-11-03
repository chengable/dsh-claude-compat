// v0.5.0 focused self-check: plugin-marketplace support. Every case runs on a
// synthetic fixture under a tmp dir — a plugins root shaped exactly like the one
// Claude Code writes (<root>/installed_plugins.json plus
// <root>/cache/<marketplace>/<name>/<version>) and a plugin laying out
// skills/commands/agents. Nothing here reads this machine's real ~/.claude
// installs, so the suite passes on any machine and does not rot when a plugin
// upgrades or is uninstalled.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SkillRegistry } from '@deepseek-ai/dsh-skill';
import {
  readInstalledClaudePlugins,
  discoverPluginContent,
  translatePluginMcp,
} from '../src/plugins.js';
import { apply, Config } from '../src/index.js';

function makeSandbox(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Fixture writers: the on-disk shapes Claude Code plugins ship.
function writeSkill(parentDir, name, description = `${name} skill`) {
  const dir = join(parentDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}\n`);
}

function writeCommand(parentDir, name, description = `${name} command`) {
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(join(parentDir, `${name}.md`), `---\ndescription: ${description}\n---\nrun ${name}\n`);
}

function writeAgent(parentDir, name, description = `${name} agent`) {
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(join(parentDir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}\n`);
}

// ─── readInstalledClaudePlugins (synthetic registry) ─────────────────────────

test('readInstalledClaudePlugins: parses a Claude Code plugins registry', () => {
  const root = makeSandbox('dcc-registry-');
  // The layout Claude Code creates: installs live under
  // <pluginsRoot>/cache/<marketplace>/<name>/<version>, keyed name@marketplace.
  const omcVersion = '4.15.7';
  const omcPath = join(root, 'cache', 'omc', 'oh-my-claudecode', omcVersion);
  const otherPath = join(root, 'cache', 'mk', 'other-plug', '2.1.0');
  mkdirSync(omcPath, { recursive: true });
  mkdirSync(otherPath, { recursive: true });
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'oh-my-claudecode@omc': [{ scope: 'user', installPath: omcPath, version: omcVersion }],
      'other-plug@mk': [{ scope: 'user', installPath: otherPath, version: '2.1.0' }],
    },
  }));

  const plugins = readInstalledClaudePlugins(root);
  assert.ok(plugins.length >= 2, `expected ≥2 plugins, got ${plugins.length}`);
  const omc = plugins.find((p) => p.name === 'oh-my-claudecode');
  assert.ok(omc, 'oh-my-claudecode present');
  assert.equal(omc.marketplace, 'omc');
  // Version is whatever the registry records — assert the shape, not a pinned
  // release (a pinned one breaks on every plugin upgrade).
  assert.match(omc.version, /^\d+\.\d+\.\d+/);
  assert.equal(omc.installPath, join(root, 'cache/omc/oh-my-claudecode', omc.version));
  // every entry carries the 5 fields
  for (const p of plugins) {
    for (const k of ['key', 'name', 'marketplace', 'installPath', 'version']) {
      assert.equal(typeof p[k], 'string', `${p.key}.${k} is a string`);
    }
  }
  // malformed / missing → []
  assert.deepEqual(readInstalledClaudePlugins(join(root, 'does-not-exist')), []);
  assert.deepEqual(readInstalledClaudePlugins('/nonexistent-dcc-plugins'), []);

  // Registry edge cases: reinstall records are appended, so the LAST user-scope
  // entry is the live one; project-scope records belong to another scope and are
  // skipped; a record set that is not an array, or an entry with no installPath,
  // is dropped rather than surfacing a plugin with nowhere to read from.
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      're@mk': [
        { scope: 'user', installPath: '/stale/re/1.0.0', version: '1.0.0' },
        { scope: 'project', installPath: '/project/re', version: '9.0.0' },
        { scope: 'user', installPath: '/fresh/re/2.0.0', version: '2.0.0' },
      ],
      'no-install-path@mk': [{ scope: 'user', version: '3.0.0' }],
      'not-an-array@mk': { scope: 'user', installPath: '/nope' },
      plainkey: [{ scope: 'user', installPath: '/plain/1.0.0', version: '1.0.0' }],
    },
  }));
  const edge = new Map(readInstalledClaudePlugins(root).map((p) => [p.key, p]));
  assert.equal(edge.get('re@mk').installPath, '/fresh/re/2.0.0', 'last user record wins');
  assert.equal(edge.get('re@mk').version, '2.0.0');
  assert.equal(edge.has('no-install-path@mk'), false, 'entry without installPath dropped');
  assert.equal(edge.has('not-an-array@mk'), false, 'non-array record set dropped');
  assert.equal(edge.get('plainkey').name, 'plainkey', 'key without @ is the whole name');
  assert.equal(edge.get('plainkey').marketplace, '');
});

// ─── discoverPluginContent (synthetic large plugin) ──────────────────────────


test('discoverPluginContent: a large plugin yields every skill, command and agent', async () => {
  const root = makeSandbox('dcc-bigplug-');
  const version = '4.15.7';
  const installPath = join(root, 'cache', 'omc', 'oh-my-claudecode', version);
  // A standard Claude Code plugin: the manifest exists but declares no
  // skills/commands/agents dirs, so the conventional <installPath>/<kind> dirs
  // are scanned (the optional-field rule from v1.0.1).
  mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
  writeFileSync(join(installPath, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'oh-my-claudecode', version }));
  const skillsDir = join(installPath, 'skills');
  const commandsDir = join(installPath, 'commands');
  const agentsDir = join(installPath, 'agents');
  for (let i = 0; i < 40; i += 1) writeSkill(skillsDir, `skill-${i}`);
  for (let i = 0; i < 20; i += 1) writeCommand(commandsDir, `command-${i}`);
  for (let i = 0; i < 15; i += 1) writeAgent(agentsDir, `agent-${i}`);
  // omc ships skills/ask AND commands/ask.md: the same name in two kinds must
  // survive as two entries (cross-kind duplicates are allowed).
  writeSkill(skillsDir, 'ask', 'ask a subagent');
  writeCommand(commandsDir, 'ask', 'ask the skill');
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'oh-my-claudecode@omc': [{ scope: 'user', installPath, version }] },
  }));

  const defaultScan = await discoverPluginContent(root, 'claude-compat', 'claude-plugin', 750);
  const explicitAgents = await discoverPluginContent(
    root, 'claude-compat', 'claude-plugin', 750, { enableAgents: true });

  const omcSkills = defaultScan.filter((c) => c.path.includes('/omc/oh-my-claudecode/'));
  const skillNames = omcSkills.filter((c) => c.path.includes('/skills/'));
  const commandNames = omcSkills.filter((c) => c.path.includes('/commands/'));
  const agentNames = explicitAgents.filter(
    (c) => c.path.includes('/agents/') && c.path.includes('/omc/oh-my-claudecode/'));

  assert.ok(skillNames.length >= 40, `expected ≥40 skills, got ${skillNames.length}`);
  assert.ok(commandNames.length >= 20, `expected ≥20 commands, got ${commandNames.length}`);
  assert.ok(agentNames.length >= 15, `expected ≥15 agents, got ${agentNames.length}`);

  // shape: kebab names, descriptions, rank/source/provider propagated
  for (const c of omcSkills) {
    assert.match(c.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `kebab name: ${c.name}`);
    assert.ok(typeof c.description === 'string' && c.description.length > 0, `description present: ${c.name}`);
    assert.equal(c.rank, 750);
    assert.equal(c.source, 'claude-plugin');
    assert.equal(c.provider, 'claude-compat');
  }
  // cross-kind same-name pair survives as two entries …
  assert.ok(omcSkills.some((c) => c.name === 'ask' && c.path.includes('/skills/')), 'skills/ask kept');
  assert.ok(omcSkills.some((c) => c.name === 'ask' && c.path.includes('/commands/')), 'commands/ask.md kept');
  // … but no duplicate names within one kind. (Registry dedupe resolves the
  // cross-kind pair; within a kind there must be nothing to resolve.)
  const omcAll = explicitAgents.filter((c) => c.path.includes('/omc/oh-my-claudecode/'));
  for (const kind of ['skills/', 'commands/', 'agents/']) {
    const names = omcAll.filter((c) => c.path.includes(`/${kind}`)).map((c) => c.name);
    assert.equal(new Set(names).size, names.length, `no duplicate names within omc ${kind}`);
  }
  // enableAgents default (undefined) also includes agents (only ===false disables)
  const defaultAgents = defaultScan.filter((c) => c.path.includes('/agents/') && c.path.includes('/omc/'));
  assert.ok(defaultAgents.length >= 15, 'agents discovered when enableAgents omitted');
  const noAgents = await discoverPluginContent(
    root, 'claude-compat', 'claude-plugin', 750, { enableAgents: false });
  assert.equal(noAgents.filter((c) => c.path.includes('/agents/')).length, 0,
    'enableAgents: false hides agents');
});

// ─── manifest-less fallback (synthetic fixture) ──────────────────────────────

test('discoverPluginContent: manifest-less plugin falls back to dir scan', async () => {
  const root = makeSandbox('dcc-plugins-');
  const installPath = join(root, 'cache', 'local', 'bare', '1.0.0');
  writeSkill(join(installPath, 'skills'), 'alpha');
  writeSkill(join(installPath, 'skills'), 'beta');
  mkdirSync(join(installPath, 'commands'), { recursive: true });
  writeFileSync(join(installPath, 'commands', 'gamma.md'), '---\ndescription: gamma cmd\n---\nrunnable\n');
  mkdirSync(join(root), { recursive: true });
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'bare@local': [{ scope: 'user', installPath, version: '1.0.0' }] },
  }));

  const candidates = await discoverPluginContent(root, 'claude-compat', 'claude-plugin', 750);
  const names = candidates.map((c) => c.name);
  assert.ok(names.includes('alpha'), 'alpha via fallback skills scan');
  assert.ok(names.includes('beta'), 'beta via fallback skills scan');
  assert.ok(names.includes('gamma'), 'gamma via fallback commands scan');
});

// ─── translatePluginMcp (synthetic fixture) ──────────────────────────────────

test('translatePluginMcp: manifest mcpServers path → server configs, ${CLAUDE_PLUGIN_ROOT} substituted', () => {
  const root = makeSandbox('dcc-pmcp-');
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { bridge: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bridge/server.cjs'] } },
  }));
  const manifest = { name: 'fakeplug', version: '1.0.0', mcpServers: './.mcp.json' };
  const { servers, warns } = translatePluginMcp(manifest, root, { failOnStartupError: false });
  assert.equal(warns.length, 0);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].transport, 'stdio');
  assert.equal(servers[0].command, 'node');
  assert.deepEqual(servers[0].args, [join(root, 'bridge/server.cjs')]);

  // Since v1.0.2 an absent mcpServers falls back to the conventional
  // <installPath>/.mcp.json, which this sandbox has — so the same bridge server
  // is found without the manifest pointing at it.
  const conventional = translatePluginMcp({ name: 'x' }, root);
  assert.equal(conventional.servers.length, 1);
  assert.equal(conventional.servers[0].serverName, 'bridge');
  assert.equal(conventional.servers[0].args[0], join(root, 'bridge/server.cjs'));
  // A plugin with no MCP config anywhere stays empty and silent.
  assert.deepEqual(translatePluginMcp({ name: 'x' }, makeSandbox('dcc-pmcp-none-')),
    { servers: [], warns: [] });
  const missing = translatePluginMcp({ name: 'x', mcpServers: './nope.json' }, root);
  assert.equal(missing.servers.length, 0);
  assert.ok(missing.warns.length > 0);
});

// ─── collision: project skill wins over plugin skill via registry dedupe ────

test('plugins: project .claude skill (rank 50) wins same-name plugin skill (rank 750)', async () => {
  const project = makeSandbox('dcc-pcoll-project-');
  mkdirSync(join(project, '.git'));
  writeSkill(join(project, '.claude', 'skills'), 'alpha', 'project alpha');
  const userClaude = makeSandbox('dcc-pcoll-user-'); // empty user dir, no skills

  const pluginsRoot = makeSandbox('dcc-pcoll-plugins-');
  const installPath = join(pluginsRoot, 'cache', 'mk', 'plug', '1.0.0');
  writeSkill(join(installPath, 'skills'), 'alpha', 'plugin alpha');
  writeSkill(join(installPath, 'skills'), 'solo', 'plugin only');
  mkdirSync(pluginsRoot, { recursive: true });
  writeFileSync(join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'plug@mk': [{ scope: 'user', installPath, version: '1.0.0' }] },
  }));

  const ctx = new Context();
  ctx.skills = new SkillRegistry(ctx);
  await ctx.plugin({ name: 'claude-compat', apply, Config }, {
    userClaudeDir: userClaude,
    projectRootMarkers: ['.git'],
    pluginsRoot,
    enablePlugins: true,
  });

  const skills = await ctx.skills.list({ cwd: project });
  const byName = new Map(skills.map((s) => [s.name, s]));
  assert.equal(byName.get('alpha').source, 'project-claude', 'project wins collision');
  assert.equal(byName.get('alpha').description, 'project alpha');
  assert.equal(byName.get('solo').source, 'claude-plugin', 'plugin-only skill still visible');
});
