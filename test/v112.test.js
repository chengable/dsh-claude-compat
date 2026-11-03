// v1.1.0: skills / commands / agents / plugins coverage, aligned with Claude
// Code's actual semantics. Each case here used to be a silent loss:
//
//   - a plugin `commands` ARRAY was ignored (real plugins lost 8 commands),
//   - `enabledPlugins: false` was ignored, so "/cc-plugin disable" did nothing,
//   - project-scope plugin installs were dropped whole,
//   - a manifest `skills` field REPLACED the conventional scan instead of adding,
//   - commands ignored `disable-model-invocation` and `argument-hint`,
//   - a skill without `description` was dropped, `when_to_use` was misspelled,
//   - an agent's `model` / `skills` never reached the delegation header.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  discoverPluginContent,
  pluginAgentDirs,
  pluginCommandsDirs,
  pluginSkillDirs,
  readInstalledClaudePlugins,
} from '../src/plugins.js';
import { discoverCommands, discoverSkills } from '../src/index.js';
import { renderAgentContent } from '../src/agents.js';

function sandbox(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeSkill(dir, name, frontmatter = `name: ${name}\ndescription: ${name} skill`) {
  write(join(dir, name, 'SKILL.md'), `---\n${frontmatter}\n---\nbody of ${name}\n`);
}

function writeCommand(dir, name, frontmatter, body = 'do it') {
  write(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}\n`);
}

/** A plugins root with one install, its manifest and optional settings. */
function pluginRoot({ manifest, files = {}, settings }) {
  const root = sandbox('dcc-v112-root-');
  const installPath = join(root, 'cache', 'mk', 'plug', '1.0.0');
  write(join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    write(join(installPath, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  write(join(root, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'plug@mk': [{ scope: 'user', installPath, version: '1.0.0' }] },
  }));
  if (settings !== undefined) {
    write(join(root, '..', 'settings.json'), JSON.stringify(settings));
  }
  return { root, installPath };
}

// ─── plugin component directories ──────────────────────────────────────────

test('a manifest commands ARRAY is honored (and both dirs are scanned)', () => {
  const at = '/plugins/cache/x/y/1.0.0';
  assert.deepEqual(pluginCommandsDirs({ commands: ['./.claude/commands', './commands'] }, at),
    [join(at, '.claude/commands'), join(at, 'commands')]);
  assert.deepEqual(pluginCommandsDirs({ commands: './cmd' }, at), [join(at, 'cmd')]);
  assert.deepEqual(pluginCommandsDirs({}, at), [join(at, 'commands')]);
  assert.deepEqual(pluginAgentDirs({ agents: './team' }, at), [join(at, 'team')]);
  assert.deepEqual(pluginAgentDirs({}, at), [join(at, 'agents')]);
});

test('a plugin shipping commands in a declared array dir is discovered end to end', async () => {
  const { root } = pluginRoot({
    manifest: { name: 'plug', commands: ['./.claude/commands', './commands'] },
    files: { '.claude/commands/build.md': '---\ndescription: build it\n---\n$ARGUMENTS\n' },
  });
  const candidates = await discoverPluginContent(root, 'claude-compat', 'claude-plugin', 750, { enableAgents: false });
  const build = candidates.find((c) => c.name === 'build');
  assert.ok(build, 'the command in the declared array dir is found');
  assert.match(build.description, /^\[plug\]/, 'the plugin name prefixes the description');
  assert.equal(build.hasArguments, true, 'the $ARGUMENTS placeholder is flagged');
});

// ─── enabledPlugins ────────────────────────────────────────────────────────

test('enabledPlugins: false hides an installed plugin, absent means enabled', () => {
  const { root } = pluginRoot({ manifest: { name: 'plug' }, settings: { enabledPlugins: { 'plug@mk': false } } });
  assert.deepEqual(readInstalledClaudePlugins(root), [], 'a disabled plugin is not discovered');

  const other = pluginRoot({ manifest: { name: 'on' }, settings: { enabledPlugins: { 'plug@mk': true } } });
  assert.equal(readInstalledClaudePlugins(other.root).length, 1);
});

test('a project-scope-only install is still a real plugin', () => {
  const root = sandbox('dcc-v112-scope-');
  write(join(root, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'hf@hf': [{ scope: 'project', installPath: join(root, 'hf') }] },
  }));
  assert.deepEqual(readInstalledClaudePlugins(root).map((p) => p.name), ['hf']);
});

// ─── skills ────────────────────────────────────────────────────────────────

test('manifest skills ADDS the conventional skills/ directory', () => {
  const at = '/plugins/cache/x/y/1.0.0';
  assert.deepEqual(pluginSkillDirs({ skills: './.claude/skills/custom' }, at),
    [join(at, 'skills'), join(at, '.claude/skills/custom')]);
});

test('a skill without a description is kept, described by its first body line', async () => {
  const dir = sandbox('dcc-v112-nodesc-');
  write(join(dir, 'no-desc', 'SKILL.md'), '---\nname: no-desc\n---\n# Do the thing\n\nrest\n');
  const [candidate] = await discoverSkills(dir, 'claude-compat', 'project-claude', 50);
  assert.ok(candidate, 'the skill is not dropped');
  assert.equal(candidate.description, '# Do the thing');
});

test('when_to_use (snake_case) is read, not just whenToUse', async () => {
  const dir = sandbox('dcc-v112-wtu-');
  writeSkill(dir, 'guide', 'name: guide\ndescription: guide skill\nwhen_to_use: Use when guiding');
  const [candidate] = await discoverSkills(dir, 'claude-compat', 'project-claude', 50);
  assert.equal(candidate.whenToUse, 'Use when guiding');
});

// ─── commands ──────────────────────────────────────────────────────────────

test('commands honor disable-model-invocation and argument-hint', async () => {
  const dir = sandbox('dcc-v112-cmd-');
  writeCommand(dir, 'hidden', 'description: hidden cmd\ndisable-model-invocation: true');
  writeCommand(dir, 'takes-args', 'description: takes args\nargument-hint: <file> [--flag]', 'run $ARGUMENTS');
  const candidates = await discoverCommands(dir, 'claude-compat', 'project-claude', 50);
  const byName = new Map(candidates.map((c) => [c.name, c]));
  assert.equal(byName.get('hidden').invocation.modelInvocable, false);
  assert.equal(byName.get('takes-args').invocation.modelInvocable, true);
  assert.equal(byName.get('takes-args').argumentHint, '<file> [--flag]');
  assert.equal(byName.get('takes-args').hasArguments, true);
  assert.match(byName.get('takes-args').description, /args: <file>/);
});

// ─── agents ────────────────────────────────────────────────────────────────

test('an agent delegation header carries model, tools and skills', () => {
  const content = renderAgentContent(
    { agentModel: 'opus', agentTools: 'Read, Grep', agentSkills: 'review, audit' },
    'You are a reviewer.');
  assert.match(content, /Model: opus/);
  assert.match(content, /Tools: Read, Grep/);
  assert.match(content, /Skills: review, audit/);
  assert.match(content, /You are a reviewer\./);
});
