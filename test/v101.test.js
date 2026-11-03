// v1.0.1 regression tests for two silent-drop bugs:
//
// 1. findProjectRoot()/findProjectRootSync() returned undefined when no marker
//    was found, so *every* project-scoped root (`.claude/skills`,
//    `.claude/rules`) was skipped without a warning for any working directory
//    that is not a git repository. Claude Code has no such requirement.
// 2. A plugin manifest that omits the optional `skills` / `commands` fields was
//    treated as "declares nothing" instead of "uses the conventional layout", so
//    plugins such as claude-mem (22 skills), skill-creator and plugin-dev were
//    discovered but contributed zero skills — silently.
//
// Hermetic: temp directories only, no network, no claude binary, no DSH peers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PROJECT_ROOT_MARKERS, findProjectRoot, findProjectRootSync } from '../src/lib.js';
import { pluginCommandsDir, pluginSkillDirs, readInstalledClaudePlugins } from '../src/plugins.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'ccc-v101-')));

// ---------------------------------------------------------------- project root

test('findProjectRoot falls back to cwd when no marker exists (non-git project)', async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true });
  assert.equal(await findProjectRoot(cwd), cwd, 'async: cwd is the root');
  assert.equal(findProjectRootSync(cwd), cwd, 'sync: cwd is the root');
});

test('findProjectRoot still prefers the nearest marker above cwd', async () => {
  const root = tmp();
  writeFileSync(join(root, '.git'), '');
  const cwd = join(root, 'packages', 'app');
  mkdirSync(cwd, { recursive: true });
  assert.equal(await findProjectRoot(cwd), root);
  assert.equal(findProjectRootSync(cwd), root);
});

test('CLAUDE.md is a default marker, so a subdirectory session finds the project root', async () => {
  assert.deepEqual([...DEFAULT_PROJECT_ROOT_MARKERS], ['.git', 'CLAUDE.md']);
  const root = tmp();
  writeFileSync(join(root, 'CLAUDE.md'), '# project');
  const cwd = join(root, 'scripts', 'video');
  mkdirSync(cwd, { recursive: true });
  assert.equal(await findProjectRoot(cwd), root);
  assert.equal(findProjectRootSync(cwd), root);
});

test('fallbackToCwd: false keeps the old root-scoped contract used by .mcp.json', async () => {
  const cwd = tmp();
  assert.equal(await findProjectRoot(cwd, DEFAULT_PROJECT_ROOT_MARKERS, { fallbackToCwd: false }), undefined);
  assert.equal(findProjectRootSync(cwd, DEFAULT_PROJECT_ROOT_MARKERS, { fallbackToCwd: false }), undefined);
});

// ------------------------------------------------------------- plugin skills

test('a manifest without a skills field still scans <installPath>/skills', () => {
  const at = '/plugins/cache/thedotmack/claude-mem/13.34.2';
  // The exact shape claude-mem ships: a manifest with no `skills` key at all.
  assert.deepEqual(pluginSkillDirs({ name: 'claude-mem', version: '13.34.2' }, at), [join(at, 'skills')]);
  assert.deepEqual(pluginSkillDirs({ name: 'skill-creator' }, at), [join(at, 'skills')]);
  // Empty array means "not declared" as well.
  assert.deepEqual(pluginSkillDirs({ skills: [] }, at), [join(at, 'skills')]);
});

test('an absent manifest scans the conventional directories', () => {
  const at = '/plugins/cache/anthropic-agent-skills/document-skills/ca45';
  assert.deepEqual(pluginSkillDirs(undefined, at), [join(at, 'skills')]);
  assert.equal(pluginCommandsDir(undefined, at), join(at, 'commands'));
});

test('a declared skills field ADDS to the conventional skills/ scan', () => {
  // Claude Code appends a manifest's directories to the standard `skills/`
  // scan; replacing it dropped skills the plugin added to `skills/` later.
  const at = '/plugins/cache/ui-ux-pro-max-skill/ui-ux-pro-max/2.5.0';
  assert.deepEqual(pluginSkillDirs({ skills: './.claude/skills/ui-ux-pro-max' }, at),
    [join(at, 'skills'), join(at, '.claude/skills/ui-ux-pro-max')]);
  assert.deepEqual(pluginSkillDirs({ skills: ['./skills/a', './skills/b'] }, at),
    [join(at, 'skills'), join(at, 'skills/a'), join(at, 'skills/b')]);
});

test('a declared commands field wins; an absent one means <installPath>/commands', () => {
  const at = '/plugins/cache/x/y/1.0.0';
  assert.equal(pluginCommandsDir({ commands: './cmd' }, at), join(at, 'cmd'));
  assert.equal(pluginCommandsDir({ name: 'y' }, at), join(at, 'commands'));
});

// ----------------------------------------------------- installed_plugins.json

test('every scope is surfaced; a user record wins over a local one', () => {
  const root = tmp();
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'claude-mem@thedotmack': [{ scope: 'user', installPath: join(root, 'mem') }],
      'hyperframes@hyperframes': [{ scope: 'project', installPath: join(root, 'hf') }],
      'multica-cli@multica-cli': [
        { scope: 'local', installPath: join(root, 'ml') },
        { scope: 'user', installPath: join(root, 'mu') },
      ],
    },
  }));
  const got = readInstalledClaudePlugins(root);
  // A plugin installed for one project only (`hyperframes`) is still installed;
  // dropping it lost the whole plugin.
  assert.deepEqual(got.map((p) => p.name).sort(), ['claude-mem', 'hyperframes', 'multica-cli']);
  assert.equal(got.find((p) => p.name === 'multica-cli').installPath, join(root, 'mu'),
    'a user record wins over a local one');
});

// --------------------------------------------------------------- integration

// discoverPluginContent() loads ../src/index.js lazily, which needs the DSH peer
// packages. Skip the end-to-end case where those are not installed instead of
// failing the suite.
const hasDshPeers = await import('../src/index.js').then(() => true, () => false);

test('plugin with manifest but no skills field contributes its skills/ entries',
  { skip: hasDshPeers ? false : 'requires @deepseek-ai/schemastery' }, async () => {
    const root = tmp();
    const install = join(root, 'cache', 'thedotmack', 'claude-mem', '13.34.2');
    mkdirSync(join(install, 'skills', 'mem-search'), { recursive: true });
    mkdirSync(join(install, 'skills', 'what-the'), { recursive: true });
    mkdirSync(join(install, '.claude-plugin'), { recursive: true });
    writeFileSync(join(install, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'claude-mem', version: '13.34.2' }));
    for (const s of ['mem-search', 'what-the']) {
      writeFileSync(join(install, 'skills', s, 'SKILL.md'),
        `---\nname: ${s}\ndescription: ${s} skill\n---\n# ${s}\n`);
    }
    writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'claude-mem@thedotmack': [{ scope: 'user', installPath: install }] },
    }));

    const { discoverPluginContent } = await import('../src/plugins.js');
    const out = await discoverPluginContent(root, 'claude-compat', 'claude-plugin', 750, {});
    assert.deepEqual(out.map((c) => c.name).sort(), ['mem-search', 'what-the']);
  });
