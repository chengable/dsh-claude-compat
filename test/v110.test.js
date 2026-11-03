// v1.1.0: Claude Code hooks, natively. These tests pin the pieces that made the
// old bridge only half-work:
//
//   - plugin hooks (`<installPath>/hooks/hooks.json`) are discovered and get
//     `${CLAUDE_PLUGIN_ROOT}` substituted,
//   - project hook configs resolve from the *session workspace* passed in, never
//     from `process.cwd()` (a DSH host runs from a profile directory, so the old
//     process-wide lookup never found a project's settings),
//   - settings.local.json is a source, and `disableAllHooks` is honored,
//   - the payload/decision/merge semantics match Claude Code's command hooks.
//
// Everything runs on tmp fixtures; nothing reads the real ~/.claude.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  collectHookSources,
  registerHooks,
  compileMatcher,
  decodeHookOutput,
  flattenHooks,
  hooksForWorkspace,
  invalidateHookCache,
  matcherMatches,
  mergeHookOutcomes,
  parseHookConfig,
  postToolPayload,
  preToolPayload,
  sessionEndPayload,
  sessionStartPayload,
  stopPayload,
  subagentPayload,
  substituteHookCommand,
} from '../src/hooks.js';

function sandbox(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function hookConfig(command, matcher) {
  return { hooks: { PreToolUse: [{ ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: 'command', command }] }] } };
}

// ─── config parsing ─────────────────────────────────────────────────────────

test('parseHookConfig: accepts a settings file and a bare hooks.json map', () => {
  const settingsShaped = parseHookConfig(hookConfig('echo settings'));
  assert.equal(settingsShaped.groups.length, 1);
  assert.equal(settingsShaped.groups[0].event, 'PreToolUse');
  assert.equal(settingsShaped.groups[0].command, 'echo settings');

  // A plugin's hooks/hooks.json has no `hooks` wrapper — the events are top level.
  const bare = parseHookConfig({ SessionStart: [{ hooks: [{ type: 'command', command: 'echo bare' }] }] });
  assert.equal(bare.groups.length, 1);
  assert.equal(bare.groups[0].event, 'SessionStart');

  // timeout is seconds in Claude Code, milliseconds internally.
  const withTimeout = parseHookConfig({ Stop: [{ hooks: [{ type: 'command', command: 'x', timeout: 5, async: true }] }] });
  assert.equal(withTimeout.groups[0].timeoutMs, 5000);
  assert.equal(withTimeout.groups[0].async, true);
});

test('parseHookConfig: non-command handlers and seamed-out events are reported, not silently lost', () => {
  const parsed = parseHookConfig({
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'ok' }, { type: 'http', url: 'http://x' }] },
    ],
    Notification: [{ hooks: [{ type: 'command', command: 'nope' }] }],
    PostToolUseFailure: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fail' }] }],
  });
  assert.deepEqual(parsed.groups.map((g) => g.event), ['PreToolUse', 'PostToolUseFailure']);
  assert.ok(parsed.skipped.some((s) => s.type === 'http'), 'http handler skipped with a reason');
  assert.ok(parsed.skipped.some((s) => s.type === 'event' && s.event === 'Notification'), 'event without a DSH seam reported');
});

// ─── matcher dialect ───────────────────────────────────────────────────────

test('matcher dialect: word-and-pipe is a literal alternation, anything else is a regex', () => {
  assert.equal(matcherMatches('Bash', 'Bash'), true);
  assert.equal(matcherMatches('Bash', 'Edit'), false);
  assert.equal(matcherMatches('Bash|Edit', 'Edit'), true);
  assert.equal(matcherMatches('Bash|Edit', 'Read'), false);
  // Regex form: unanchored, so this matches every MCP tool name.
  assert.equal(matcherMatches('mcp__.*', 'mcp__claude-mem__search'), true);
  assert.equal(matcherMatches('Read|Write', 'mcp__x__read'), false);
  assert.equal(matcherMatches(undefined, 'anything'), true);
  assert.equal(matcherMatches('*', 'anything'), true);
  assert.equal(matcherMatches('[', 'x'), false, 'invalid regex never matches');

  // The predicate wrapper keeps its historical contract (non-string never matches).
  assert.equal(compileMatcher('Bash')('Bash'), true);
  assert.equal(compileMatcher(undefined)('x'), false);
});

test('substituteHookCommand: replaces CLAUDE_PLUGIN_ROOT and CLAUDE_PROJECT_DIR only', () => {
  const command = '"${CLAUDE_PLUGIN_ROOT}/hook.sh" --dir "${CLAUDE_PROJECT_DIR}/x" --keep $HOME';
  const out = substituteHookCommand(command, { pluginRoot: '/plugins/p1', projectDir: '/proj' });
  assert.equal(out, '"/plugins/p1/hook.sh" --dir "/proj/x" --keep $HOME');
  // Unset variables stay verbatim (the shell then expands them itself).
  assert.equal(substituteHookCommand('${CLAUDE_PLUGIN_ROOT}/a'), '${CLAUDE_PLUGIN_ROOT}/a');
});

// ─── sources: user, project, local, plugin ─────────────────────────────────

test('collectHookSources: user + project + local + every installed plugin', () => {
  const userClaude = sandbox('dcc-h-user-');
  writeJson(join(userClaude, 'settings.json'), hookConfig('echo user'));

  const project = sandbox('dcc-h-proj-');
  mkdirSync(join(project, '.git'));
  writeJson(join(project, '.claude', 'settings.json'), hookConfig('echo project'));
  writeJson(join(project, '.claude', 'settings.local.json'), hookConfig('echo local'));

  const pluginsRoot = sandbox('dcc-h-plugins-');
  const installPath = join(pluginsRoot, 'cache', 'mk', 'notifier', '1.0.0');
  writeJson(join(installPath, '.claude-plugin', 'plugin.json'), { name: 'notifier', version: '1.0.0' });
  writeJson(join(installPath, 'hooks', 'hooks.json'), {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/bin/check.sh"' }] }],
  });
  writeJson(join(pluginsRoot, 'installed_plugins.json'), {
    version: 2,
    plugins: { 'notifier@mk': [{ scope: 'user', installPath, version: '1.0.0' }] },
  });

  const sources = collectHookSources(project, { userClaudeDir: userClaude, pluginsRoot });
  assert.deepEqual(sources.map((s) => s.label), ['user', 'project', 'local', 'plugin:notifier@mk']);

  const { hooks } = flattenHooks(sources);
  const byCommand = new Map(hooks.map((h) => [h.command, h]));
  assert.ok(byCommand.has('echo user'));
  assert.ok(byCommand.has('echo local'), 'settings.local.json is a hook source');
  // The plugin's command must arrive with its root already substituted, plus
  // CLAUDE_PLUGIN_ROOT for anything the command expands itself.
  const pluginHook = hooks.find((h) => h.event === 'PreToolUse' && h.label === 'plugin:notifier@mk');
  assert.equal(pluginHook.command, `"${installPath}/bin/check.sh"`);
  assert.equal(pluginHook.env.CLAUDE_PLUGIN_ROOT, installPath);
  assert.equal(pluginHook.env.CLAUDE_PROJECT_DIR, project);
});

test('collectHookSources: disableAllHooks wins, manifest.hooks overrides the convention', () => {
  const userClaude = sandbox('dcc-h-dis-');
  writeJson(join(userClaude, 'settings.json'), { disableAllHooks: true, ...hookConfig('echo user') });

  const project = sandbox('dcc-h-man-');
  mkdirSync(join(project, '.git'));
  const installPath = join(project, 'plugins', 'p');
  writeJson(join(installPath, '.claude-plugin', 'plugin.json'), {
    name: 'p', version: '1.0.0', hooks: './custom/hooks.json',
  });
  writeJson(join(installPath, 'custom', 'hooks.json'), { Stop: [{ hooks: [{ type: 'command', command: 'custom-stop' }] }] });
  // The conventional path exists too — the manifest must win.
  writeJson(join(installPath, 'hooks', 'hooks.json'), { Stop: [{ hooks: [{ type: 'command', command: 'conventional-stop' }] }] });

  const pluginsRoot = sandbox('dcc-h-man-plugins-');
  writeJson(join(pluginsRoot, 'installed_plugins.json'), {
    version: 2,
    plugins: { 'p@mk': [{ scope: 'user', installPath, version: '1.0.0' }] },
  });

  const sources = collectHookSources(project, { userClaudeDir: userClaude, pluginsRoot });
  assert.equal(sources.some((s) => s.label === 'user'), false, 'disableAllHooks drops the user source');
  const { hooks } = flattenHooks(sources);
  assert.deepEqual(hooks.map((h) => h.command), ['custom-stop']);
});

test('flattenHooks: an identical (event, matcher, command) triple runs once', () => {
  const project = sandbox('dcc-h-dedupe-');
  mkdirSync(join(project, '.git'));
  writeJson(join(project, '.claude', 'settings.json'), hookConfig('echo same'));
  const userClaude = sandbox('dcc-h-dedupe-user-');
  writeJson(join(userClaude, 'settings.json'), hookConfig('echo same'));

  const { hooks } = flattenHooks(collectHookSources(project, { userClaudeDir: userClaude, pluginsRoot: sandbox('dcc-h-none-') }));
  assert.equal(hooks.length, 1);
});

// ─── per-session workspace (the cwd regression) ────────────────────────────

test('hooks resolve from the session workspace, not the process cwd', () => {
  invalidateHookCache();
  const userClaude = sandbox('dcc-h-ws-user-');
  const projectA = sandbox('dcc-h-ws-a-');
  mkdirSync(join(projectA, '.git'));
  writeJson(join(projectA, '.claude', 'settings.json'), hookConfig('echo project-a'));

  const other = sandbox('dcc-h-ws-other-');
  const config = { userClaudeDir: userClaude, pluginsRoot: sandbox('dcc-h-ws-plugins-') };

  const inProject = hooksForWorkspace(projectA, config);
  assert.deepEqual(inProject.hooks.map((h) => h.command), ['echo project-a']);
  assert.equal(inProject.projectRoot, projectA);

  // A session in an unrelated directory must not inherit project A's hooks —
  // this is exactly what a process-cwd lookup got wrong.
  const elsewhere = hooksForWorkspace(other, config);
  assert.deepEqual(elsewhere.hooks, []);

  // Cached until invalidated, then re-read (a reload picks up new plugins/edits).
  writeJson(join(projectA, '.claude', 'settings.json'), hookConfig('echo project-a-v2'));
  assert.deepEqual(hooksForWorkspace(projectA, config).hooks.map((h) => h.command), ['echo project-a']);
  invalidateHookCache();
  assert.deepEqual(hooksForWorkspace(projectA, config).hooks.map((h) => h.command), ['echo project-a-v2']);
});

// ─── decoding and merging ──────────────────────────────────────────────────

test('decodeHookOutput: exit 2 blocks with stderr, structured JSON maps to decisions', () => {
  assert.deepEqual(decodeHookOutput({ exitCode: 2, stdout: '', stderr: 'not allowed' }, 'PreToolUse'),
    { decision: 'deny', reason: 'not allowed' });

  // Legacy top-level decision is approve|block only.
  assert.equal(decodeHookOutput({ exitCode: 0, stdout: '{"decision":"block","reason":"no"}', stderr: '' },
    'UserPromptSubmit').decision, 'deny');
  assert.equal(decodeHookOutput({ exitCode: 0, stdout: '{"decision":"approve"}', stderr: '' },
    'UserPromptSubmit').decision, 'allow');
  // An out-of-schema top-level "deny" must not become a real denial.
  assert.equal(decodeHookOutput({ exitCode: 0, stdout: '{"decision":"deny"}', stderr: '' },
    'PreToolUse').decision, undefined);

  const specific = decodeHookOutput({
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: 'needs review',
        additionalContext: 'extra',
      },
    }),
    stderr: '',
  }, 'PreToolUse');
  assert.equal(specific.decision, 'ask');
  assert.equal(specific.reason, 'needs review');
  assert.equal(specific.additionalContext, 'extra');

  // A block naming another event cannot affect the firing one.
  const mismatched = decodeHookOutput({
    exitCode: 0,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'deny' } }),
    stderr: '',
  }, 'PreToolUse');
  assert.equal(mismatched.decision, undefined);

  // Non-blocking errors carry no decision.
  assert.equal(decodeHookOutput({ exitCode: 7, stdout: 'boom', stderr: 'warn' }, 'PreToolUse').decision, undefined);
});

test('mergeHookOutcomes: deny beats ask beats allow, reasons join, contexts accumulate', () => {
  const merged = mergeHookOutcomes([
    { decision: 'allow' },
    { decision: 'ask', reason: 'needs approval' },
    { decision: 'deny', reason: 'policy says no', additionalContext: 'ctx-1' },
    { decision: 'deny', reason: 'second denial', additionalContext: 'ctx-2' },
  ]);
  assert.equal(merged.decision, 'deny');
  assert.equal(merged.reason, 'policy says no\n\nsecond denial', 'only the winning rank explains the decision');
  assert.deepEqual(merged.additionalContext, ['ctx-1', 'ctx-2']);

  const stoppable = mergeHookOutcomes([{ continue: false, stopReason: 'halt' }]);
  assert.equal(stoppable.stop, true);
  assert.equal(stoppable.stopReason, 'halt');
  assert.equal(mergeHookOutcomes([]).decision, 'none');
});

// ─── payloads ──────────────────────────────────────────────────────────────

test('payloads carry the Claude Code field names, including the session cwd', () => {
  const agent = { session: { id: 'session-1', header: { id: 'session-1', cwd: '/work/proj' } } };
  const start = JSON.parse(sessionStartPayload(agent, 'resume'));
  assert.equal(start.session_id, 'session-1');
  assert.equal(start.cwd, '/work/proj');
  assert.equal(start.hook_event_name, 'SessionStart');
  assert.equal(start.transcript_path, '');
  assert.equal(start.source, 'resume');

  const end = JSON.parse(sessionEndPayload(agent));
  assert.equal(end.hook_event_name, 'SessionEnd');
  assert.equal(end.reason, 'session_end');

  const exec = { agent, callId: 'call-9', name: 'Bash', arguments: { command: 'ls' } };
  const pre = JSON.parse(preToolPayload(exec));
  assert.equal(pre.tool_name, 'Bash');
  assert.equal(pre.tool_use_id, 'call-9');
  assert.deepEqual(pre.tool_input, { command: 'ls' });

  const post = JSON.parse(postToolPayload(exec, { content: [{ type: 'text', text: 'output' }] }, 'PostToolUse'));
  assert.equal(post.tool_response, 'output');
  const failed = JSON.parse(postToolPayload(exec, { content: [], error: 'boom' }, 'PostToolUseFailure'));
  assert.equal(failed.error, 'boom');

  assert.equal(JSON.parse(stopPayload(agent)).stop_hook_active, false);
  const sub = JSON.parse(subagentPayload('SubagentStart', { id: 'agent-7' }, agent));
  assert.equal(sub.agent_id, 'agent-7');
  assert.equal(sub.agent_type, 'general-purpose');
});

test('hook chatter is decoded and merged as a user-visible notice', () => {
  // Plain stdout on a clean exit is what Claude Code shows as hook output.
  const decoded = decodeHookOutput({ exitCode: 0, stdout: '🧬 review threshold reached', stderr: '' }, 'Stop');
  assert.equal(decoded.plain, '🧬 review threshold reached');
  assert.equal(decoded.decision, undefined);

  // `systemMessage` is the explicit user-facing field and wins over plain stdout.
  const merged = mergeHookOutcomes([
    decodeHookOutput({ exitCode: 0, stdout: 'plain text', stderr: '' }, 'Stop'),
    decodeHookOutput({ exitCode: 0, stdout: JSON.stringify({ systemMessage: 'explicit note' }), stderr: '' }, 'Stop'),
  ]);
  assert.deepEqual(merged.messages, ['plain text', 'explicit note']);

  // Structured JSON is not repeated as a notice.
  const json = mergeHookOutcomes([
    decodeHookOutput({ exitCode: 0, stdout: JSON.stringify({ additionalContext: 'ctx' }), stderr: '' }, 'Stop'),
  ]);
  assert.deepEqual(json.messages, []);
  assert.deepEqual(json.additionalContext, ['ctx']);
});

test('wiring: a Stop hook notice reaches the next prompt as a notice message', async () => {
  // Real path: Stop hook prints {"systemMessage": …} → queued at turn-stopping →
  // delivered with the next prompt. Exercises registerHooks, not just the codec.
  const project = sandbox('dcc-notice-');
  mkdirSync(join(project, '.git'));
  writeJson(join(project, '.claude', 'settings.json'), {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo \'{"systemMessage":"review threshold reached"}\'' }] }],
    },
  });

  const listeners = new Map();
  const ctx = {
    on: (name, fn) => { listeners.set(name, fn); return () => {}; },
    get: () => undefined,
  };
  invalidateHookCache();
  registerHooks(ctx, { userClaudeDir: join(project, 'nouser'), pluginsRoot: join(project, 'noplugins') });

  const agent = { session: { header: { id: 'session-wiring', cwd: project } } };
  await listeners.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal });

  // Next prompt: the notice must ride along with the claimed messages.
  const decision = await listeners.get('agent/pre-step')(
    { agent, messages: [{ content: [{ type: 'text', text: 'hi' }] }] },
    async () => ({ kind: 'enter', messages: [{ content: [{ type: 'text', text: 'hi' }] }] }),
  );
  assert.equal(decision.kind, 'enter');
  const texts = decision.messages.flatMap((m) => m.content.map((c) => c.text));
  assert.ok(texts.includes('review threshold reached'), `notice delivered, got ${JSON.stringify(texts)}`);
  const notice = decision.messages.find((m) => m.content.some((c) => c.text === 'review threshold reached'));
  // `hook-context` (not `notice`): the desktop client drops a declared notice
  // whose source it has no producer for, which made the message invisible.
  assert.equal(notice.source.form, 'hook-context');
  assert.equal(notice.source.kind, 'plugin:dsh-claude-compat');

  // The buffer is drained: a second prompt must not repeat it.
  const second = await listeners.get('agent/pre-step')(
    { agent, messages: [{ content: [{ type: 'text', text: 'again' }] }] },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.deepEqual(second.messages, []);
});

test('wiring: notice text is stripped of terminal color codes', async () => {
  const project = sandbox('dcc-ansi-');
  mkdirSync(join(project, '.git'));
  // A real ESC byte, written by printf as octal so no JS escaping is involved.
  writeFileSync(join(project, 'hook.sh'), "#!/bin/sh\nprintf '\\033[1m\\033[93m🧬 colored notice\\033[0m\\n'\n");
  writeJson(join(project, '.claude', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `sh ${join(project, 'hook.sh')}` }] }] },
  });
  const listeners = new Map();
  registerHooks({ on: (n, f) => { listeners.set(n, f); return () => {}; }, get: () => undefined },
    { userClaudeDir: join(project, 'nouser'), pluginsRoot: join(project, 'noplugins') });
  invalidateHookCache();

  const agent = { session: { header: { id: 'session-ansi', cwd: project } } };
  await listeners.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal });
  const d = await listeners.get('agent/pre-step')(
    { agent, messages: [{ content: [{ type: 'text', text: 'hi' }] }] },
    async () => ({ kind: 'enter', messages: [] }),
  );
  const text = (d.messages ?? []).flatMap((m) => m.content.map((c) => c.text)).join('');
  assert.equal(text, '🧬 colored notice', 'escape sequences are stripped before display');
});

test('wiring: a Stop notice survives a restart and renders on the next prompt', async () => {
  // The rendered path is inbox delivery (a claimed user message); it must also
  // survive the process boundary, which a memory-only queue does not.
  const project = sandbox('dcc-notice-persist-');
  mkdirSync(join(project, '.git'));
  writeJson(join(project, '.claude', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo \'{"systemMessage":"persisted notice"}\'' }] }] },
  });
  const agent = { session: { header: { id: 'session-persist-1', cwd: project } } };

  const first = new Map();
  registerHooks({ on: (n, f) => { first.set(n, f); return () => {}; }, get: () => undefined },
    { userClaudeDir: join(project, 'nouser'), pluginsRoot: join(project, 'noplugins') });
  invalidateHookCache();
  await first.get('agent/turn-stopping')({ agent, turn: 1, signal: new AbortController().signal });

  // Simulate a restart: fresh listener set (fresh in-memory queue), same session.
  const second = new Map();
  registerHooks({ on: (n, f) => { second.set(n, f); return () => {}; }, get: () => undefined },
    { userClaudeDir: join(project, 'nouser'), pluginsRoot: join(project, 'noplugins') });
  const d = await second.get('agent/pre-step')(
    { agent, messages: [{ content: [{ type: 'text', text: 'hi' }] }] },
    async () => ({ kind: 'enter', messages: [] }),
  );
  const texts = (d.messages ?? []).flatMap((m) => m.content.map((c) => c.text));
  assert.ok(texts.includes('persisted notice'), `notice survived the restart, got ${JSON.stringify(texts)}`);

  // Drained exactly once: a third prompt sees nothing.
  const again = await second.get('agent/pre-step')(
    { agent, messages: [{ content: [{ type: 'text', text: 'again' }] }] },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.deepEqual(again.messages, []);
});
