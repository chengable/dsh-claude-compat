// v1.0.3: the defaults are the configuration.
//
// `enablePluginMcp` used to default to false, so mounting the MCP servers that
// installed Claude Code plugins declare required a profile `cordis.patch.yml`
// row. Profile rows do not survive a plugin reinstall: the patch is repaired or
// replaced and the plugin silently goes back to "no plugin MCP servers". The
// same reasoning applies to `projectRootMarkers` (a non-git project lost all
// project-scoped discovery without the row).
//
// These assertions pin the defaults so the fork's out-of-the-box behaviour is
// the one that was actually wanted, and a reinstall cannot regress it.
//
// Requires the DSH peer packages; skipped where they are absent (the same
// condition that makes v040/v050/self-check unimportable in a bare checkout).

import test from 'node:test';
import assert from 'node:assert/strict';

const loaded = await import('../src/index.js').then((m) => m, () => undefined);
const skip = loaded === undefined ? 'requires the @deepseek-ai DSH peer packages' : false;

test('enablePluginMcp defaults to true so a reinstall keeps plugin MCP servers',
  { skip }, () => {
    const config = loaded.Config({});
    assert.equal(config.enablePluginMcp, true);
    // The two prerequisites keep their own defaults.
    assert.equal(config.enablePlugins, true);
    assert.equal(config.enableMcp, true);
  });

test('set enablePluginMcp: false explicitly to keep plugin MCP servers off',
  { skip }, () => {
    assert.equal(loaded.Config({ enablePluginMcp: false }).enablePluginMcp, false);
  });

test('projectRootMarkers defaults to .git plus CLAUDE.md, covering non-git projects',
  { skip }, () => {
    assert.deepEqual([...loaded.Config({}).projectRootMarkers], ['.git', 'CLAUDE.md']);
  });

test('the rest of the skill/rules surface keeps its defaults',
  { skip }, () => {
    const config = loaded.Config({});
    for (const key of ['enableSkills', 'enableRules', 'enableHooks', 'enableAgents']) {
      assert.equal(config[key], true, `${key} should stay on by default`);
    }
    assert.equal(config.skillRank, 50, 'project .claude still wins collisions');
    assert.equal(config.pluginSkillRank, 750, 'plugin content stays the long tail');
  });
