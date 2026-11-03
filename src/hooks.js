// dsh-claude-compat: Claude Code hooks, bridged natively onto DSH's typed
// interception points — no second plugin required.
//
// Hook sources, in Claude Code's own precedence order (an identical
// (event, matcher, command) triple runs once; different commands all run):
//
//   1. `~/.claude/settings.json`                     (user)
//   2. `<projectRoot>/.claude/settings.json`         (project)
//   3. `<projectRoot>/.claude/settings.local.json`   (local, usually gitignored)
//   4. `<installPath>/hooks/hooks.json` of every installed Claude Code plugin
//      (or whatever the plugin manifest's `hooks` field names)
//
// The project sources resolve from the **session workspace**, never from the
// process cwd: a DSH host is launched from a profile directory, so a
// process-wide resolution would silently never see a project's hooks.
//
// Supported events and their DSH interception points:
//
//   SessionStart        agent/created          (context injection)
//   UserPromptSubmit    agent/pre-step         (block the prompt, add context)
//   PreToolUse          tools/pre-execute      (deny / ask)
//   PostToolUse         tools/post-execute     (block the result, add context)
//   PostToolUseFailure  tools/post-execute     (same point, error results only)
//   Stop                agent/turn-stopping    (force another step)
//   SubagentStart       subagent/start         (inject into the child)
//   SubagentStop        subagent/end           (observe only)
//   SessionEnd          agent/disposed         (fire and forget)
//
// Events DSH has no seam for are reported, never silently dropped:
// Notification (no DSH event), PreCompact (the running DSH raises no compaction
// event), Setup (no plugin-install event).
//
// Command hooks only: `http`, `mcp_tool`, `prompt` and `agent` handlers are
// parsed and skipped with a warning, like the reference bridges.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  CLAUDE_COMPAT_SOURCE_KIND,
  DEFAULT_PROJECT_ROOT_MARKERS,
  findProjectRootSync,
  resolveUserClaudeDir,
} from './lib.js';
import { readInstalledClaudePlugins } from './plugins.js';

// ─── event inventory ────────────────────────────────────────────────────────

/** Events this bridge can run on the running DSH. */
const SUPPORTED_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
]);

/** Events Claude Code defines that have no DSH seam (reported once at load). */
const UNSUPPORTED_EVENTS = new Set(['Notification', 'PreCompact', 'Setup', 'TeammateIdle', 'TaskCompleted']);

// ─── matcher ────────────────────────────────────────────────────────────────

/**
 * Claude Code's matcher dialect: a pattern made only of word characters and
 * `|` is a literal alternation (`Bash|Edit`); anything else is an unanchored
 * regular expression (`mcp__.*`, `.*`). Absent, empty and `*` match everything.
 */
const CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/;

function isMatchAll(matcher) {
  return matcher === undefined || matcher === null || matcher === '' || matcher === '*';
}

/** Whether `matcher` selects `query`. Invalid regexes never match. */
export function matcherMatches(matcher, query) {
  if (isMatchAll(matcher)) return true;
  const pattern = String(matcher);
  if (CLAUDE_LITERAL.test(pattern)) {
    return pattern.split('|').some((part) => part === query);
  }
  try {
    return new RegExp(pattern).test(query);
  } catch {
    return false;
  }
}

/**
 * Compile a matcher into a predicate. Kept for callers that want a function;
 * a non-string degrades to never-match (callers pass `'*'` for match-all).
 */
export function compileMatcher(matcher) {
  if (typeof matcher !== 'string') return () => false;
  return (name) => matcherMatches(matcher, name);
}

/** Validate one matcher; returns a diagnostic or undefined. */
export function matcherDiagnostic(matcher) {
  if (isMatchAll(matcher)) return undefined;
  const pattern = String(matcher);
  if (CLAUDE_LITERAL.test(pattern)) return undefined;
  try {
    new RegExp(pattern);
    return undefined;
  } catch {
    return `invalid regex matcher: ${JSON.stringify(pattern)}`;
  }
}

// ─── command substitution ───────────────────────────────────────────────────

/** Replace the two variables Claude Code expands inside hook command strings. */
export function substituteHookCommand(command, vars = {}) {
  let out = String(command);
  if (vars.pluginRoot !== undefined) out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot);
  if (vars.projectDir !== undefined) out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir);
  return out;
}

// ─── config parsing ─────────────────────────────────────────────────────────

/**
 * Parse one hook config body. Accepts both shapes Claude Code writes: a
 * settings object with a `hooks` key, or a bare `{ Event: [...] }` map (the
 * `hooks/hooks.json` shape plugins ship).
 *
 * @returns `{ groups, skipped }` with normalized hook records.
 */
export function parseHookConfig(raw, { label = '' } = {}) {
  const groups = [];
  const skipped = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { groups, skipped };
  const map = typeof raw.hooks === 'object' && raw.hooks !== null && !Array.isArray(raw.hooks)
    ? raw.hooks
    : raw;
  for (const [eventName, entries] of Object.entries(map)) {
    if (UNSUPPORTED_EVENTS.has(eventName)) {
      if (Array.isArray(entries) && entries.length > 0) skipped.push({ label, event: eventName, type: 'event' });
      continue;
    }
    if (!SUPPORTED_EVENTS.has(eventName) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const matcher = typeof entry.matcher === 'string' ? entry.matcher : undefined;
      const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const hook of hooks) {
        if (typeof hook !== 'object' || hook === null) continue;
        const type = typeof hook.type === 'string' ? hook.type : 'command';
        if (type !== 'command' || typeof hook.command !== 'string' || hook.command.length === 0) {
          skipped.push({ label, event: eventName, type });
          continue;
        }
        groups.push({
          event: eventName,
          matcher,
          command: hook.command,
          timeoutMs: typeof hook.timeout === 'number' && hook.timeout > 0 ? hook.timeout * 1000 : undefined,
          async: hook.async === true,
          label,
        });
      }
    }
  }
  return { groups, skipped };
}

function readJsonFile(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return undefined; }
  try { return JSON.parse(raw); } catch {
    console.warn(`dsh-claude-compat: unparseable hook config, ignoring: ${path}`);
    return undefined;
  }
}

/** Extra hook config files a plugin declares through its manifest `hooks` field. */
function manifestHookConfigs(manifest, installPath) {
  const value = manifest?.hooks;
  if (typeof value === 'string') return [join(installPath, value)];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').map((v) => join(installPath, v));
  return [];
}

/**
 * Every hook source that applies to one session workspace, in precedence order.
 * Each source carries the variables its commands need substituted.
 */
export function collectHookSources(cwd, config = {}) {
  const sources = [];
  const userDir = resolveUserClaudeDir(config.userClaudeDir);
  const projectRoot = findProjectRootSync(cwd, config.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS);

  const add = (label, path, vars = {}) => {
    const parsed = readJsonFile(path);
    if (parsed === undefined) return;
    // Claude Code lets a settings file opt out of every hook it declares.
    if (parsed.disableAllHooks === true) return;
    sources.push({ label, path, vars: { projectDir: projectRoot, ...vars }, parsed });
  };

  add('user', join(userDir, 'settings.json'));
  if (projectRoot !== undefined) {
    add('project', join(projectRoot, '.claude', 'settings.json'));
    add('local', join(projectRoot, '.claude', 'settings.local.json'));
  }

  if (config.enablePlugins !== false && config.enablePluginHooks !== false) {
    for (const plugin of readInstalledClaudePlugins(config.pluginsRoot)) {
      const installPath = plugin.installPath;
      const manifest = readJsonFile(join(installPath, '.claude-plugin', 'plugin.json'));
      const declared = manifestHookConfigs(manifest, installPath);
      const paths = declared.length > 0 ? declared : [join(installPath, 'hooks', 'hooks.json')];
      for (const path of paths) {
        const parsed = readJsonFile(path);
        if (parsed === undefined) continue;
        sources.push({
          label: `plugin:${plugin.key}`,
          path,
          vars: { pluginRoot: installPath, projectDir: projectRoot },
          parsed,
        });
      }
    }
  }
  return sources;
}

/** Flatten sources into hook records, de-duplicating identical triples. */
export function flattenHooks(sources) {
  const out = [];
  const seen = new Set();
  const skipped = [];
  for (const source of sources) {
    const parsed = parseHookConfig(source.parsed, { label: source.label });
    for (const s of parsed.skipped) skipped.push(s);
    for (const group of parsed.groups) {
      const command = substituteHookCommand(group.command, source.vars);
      const key = `${group.event}\u0000${group.matcher ?? '*'}\u0000${command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...group,
        command,
        env: {
          ...(source.vars.pluginRoot !== undefined ? { CLAUDE_PLUGIN_ROOT: source.vars.pluginRoot } : {}),
          ...(source.vars.projectDir !== undefined ? { CLAUDE_PROJECT_DIR: source.vars.projectDir } : {}),
        },
      });
    }
  }
  return { hooks: out, skipped };
}

// Cache per project root: hooks re-read when a new workspace is seen, and
// explicitly invalidated by /reload-cc-plugins. Without it every tool call
// would re-read several JSON files.
const hookCache = new Map();

/** Drop every cached hook config (reload skill, plugin install/removal). */
export function invalidateHookCache() {
  hookCache.clear();
}

/** Resolve (and cache) the hooks that apply to one session workspace. */
export function hooksForWorkspace(cwd, config = {}) {
  const projectRoot = findProjectRootSync(cwd, config.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS) ?? cwd;
  const key = `${projectRoot}\u0000${config.userClaudeDir ?? ''}\u0000${config.pluginsRoot ?? ''}`;
  const cached = hookCache.get(key);
  if (cached !== undefined) return cached;
  const sources = collectHookSources(cwd, config);
  const { hooks, skipped } = flattenHooks(sources);
  for (const s of skipped) {
    console.warn(
      s.type === 'event'
        ? `dsh-claude-compat: hook event "${s.event}" (${s.label}) has no DSH interception point — skipped`
        : `dsh-claude-compat: hook type "${s.type}" (${s.event}, ${s.label}) is not a command hook — skipped`);
  }
  const result = { projectRoot, hooks };
  hookCache.set(key, result);
  return result;
}

// ─── payloads (the Claude Code stdin dialect) ───────────────────────────────

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function agentSessionId(agent) {
  return agent?.session?.header?.id ?? agent?.session?.id ?? 'unknown';
}

function agentCwd(agent, fallback) {
  return agent?.session?.header?.cwd ?? fallback ?? process.cwd();
}

function basePayload(agent, event, cwd) {
  return {
    session_id: agentSessionId(agent),
    transcript_path: '',
    cwd: agentCwd(agent, cwd),
    hook_event_name: event,
  };
}

/** SessionStart payload (field-compatible with the v0.8.0 contract). */
export function sessionStartPayload(agent, source, cwd) {
  return JSON.stringify({
    ...basePayload(agent, 'SessionStart', cwd),
    source: source ?? 'startup',
  });
}

/** SessionEnd payload — SessionStart's counterpart with the same base fields. */
export function sessionEndPayload(agent, cwd) {
  return JSON.stringify({
    ...basePayload(agent, 'SessionEnd', cwd),
    reason: 'session_end',
  });
}

export function promptPayload(agent, messages, cwd) {
  const content = (messages ?? []).flatMap((m) => (Array.isArray(m?.content) ? m.content : []));
  return JSON.stringify({
    ...basePayload(agent, 'UserPromptSubmit', cwd),
    prompt: content.filter((b) => b?.type === 'text').map((b) => b.text).join(''),
  });
}

export function preToolPayload(exec, cwd) {
  return JSON.stringify({
    ...basePayload(exec?.agent, 'PreToolUse', cwd),
    tool_name: exec?.name ?? '',
    tool_input: exec?.arguments ?? {},
    tool_use_id: exec?.callId ?? '',
  });
}

export function postToolPayload(exec, result, event, cwd) {
  const failed = event === 'PostToolUseFailure';
  return JSON.stringify({
    ...basePayload(exec?.agent, event, cwd),
    tool_name: exec?.name ?? '',
    tool_input: exec?.arguments ?? {},
    tool_use_id: exec?.callId ?? '',
    tool_response: blockText(result?.content ?? result),
    ...(failed ? { error: blockText(result?.error ?? result?.message ?? '') } : {}),
  });
}

export function stopPayload(agent, cwd) {
  return JSON.stringify({
    ...basePayload(agent, 'Stop', cwd),
    stop_hook_active: false,
  });
}

export function subagentPayload(event, info, child, cwd) {
  return JSON.stringify({
    ...basePayload(child, event, cwd),
    agent_id: info?.id ?? '',
    // DSH's subagent seam carries no per-kind label; Claude Code's Task-tool
    // default is what a `*`/default matcher matches.
    agent_type: 'general-purpose',
    ...(event === 'SubagentStop' ? { stop_hook_active: false } : {}),
  });
}

// ─── execution ──────────────────────────────────────────────────────────────

/** Run one hook command, feeding the payload on stdin (Claude appends `\n`). */
export function runHookCommand(command, stdin, { timeoutMs = 60_000, cwd, env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = execFile('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      console.warn(`dsh-claude-compat: hook timed out after ${timeoutMs}ms, killed: ${command}`);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(1);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(`${stdin}\n`);
  });
}

// ─── output decoding and merging ────────────────────────────────────────────

/**
 * Decode one hook's process outcome into a neutral record.
 *
 * Exit 2 blocks and uses stderr as the reason. Exit 0 may carry JSON:
 * `continue`, `stopReason`, `systemMessage`, the legacy top-level
 * `decision` (`approve`/`block` only), and `hookSpecificOutput`
 * (`permissionDecision` allow|deny|ask, `permissionDecisionReason`,
 * `additionalContext`, `updatedInput`), gated by `hookEventName`.
 */
export function decodeHookOutput({ exitCode, stdout, stderr }, expectedEvent) {
  const decoded = {};
  const out = (stdout ?? '').trim();
  if (exitCode === 2) {
    decoded.decision = 'deny';
    const reason = (stderr ?? '').trim();
    if (reason.length > 0) decoded.reason = reason;
    return decoded;
  }
  if (exitCode !== 0 || !out.startsWith('{')) return decoded;
  let parsed;
  try { parsed = JSON.parse(out); } catch { return decoded; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return decoded;

  if (typeof parsed.continue === 'boolean') decoded.continue = parsed.continue;
  if (typeof parsed.stopReason === 'string') decoded.stopReason = parsed.stopReason;
  if (typeof parsed.systemMessage === 'string') decoded.systemMessage = parsed.systemMessage;
  // The legacy top-level decision is only approve|block; allow/deny/ask are
  // reserved for hookSpecificOutput and must not leak in here.
  if (parsed.decision === 'approve') decoded.decision = 'allow';
  if (parsed.decision === 'block') decoded.decision = 'deny';
  if (typeof parsed.reason === 'string') decoded.reason = parsed.reason;

  const specific = parsed.hookSpecificOutput;
  if (typeof specific === 'object' && specific !== null && !Array.isArray(specific)) {
    const eventName = typeof specific.hookEventName === 'string' ? specific.hookEventName : undefined;
    // A block claiming another event cannot affect the firing one.
    if (expectedEvent === undefined || eventName === expectedEvent) {
      const permission = specific.permissionDecision;
      if (permission === 'allow' || permission === 'deny' || permission === 'ask') {
        decoded.decision = permission;
      }
      if (typeof specific.permissionDecisionReason === 'string') decoded.reason = specific.permissionDecisionReason;
      if (typeof specific.additionalContext === 'string' && specific.additionalContext.length > 0) {
        decoded.additionalContext = specific.additionalContext;
      }
      if (typeof specific.updatedInput === 'object' && specific.updatedInput !== null) {
        decoded.updatedInput = specific.updatedInput;
      }
    }
  }
  if (typeof parsed.additionalContext === 'string' && parsed.additionalContext.length > 0) {
    decoded.additionalContext = parsed.additionalContext;
  }
  return decoded;
}

function decisionRank(decision) {
  if (decision === 'deny') return 3;
  if (decision === 'ask') return 2;
  if (decision === 'allow') return 1;
  return 0;
}

/** Fold every matched hook's outcome: deny > ask > allow, contexts accumulate. */
export function mergeHookOutcomes(outputs) {
  let rank = 0;
  const reasons = [];
  let stop = false;
  let stopReason;
  const contexts = [];
  for (const output of outputs) {
    const r = decisionRank(output.decision);
    if (r > rank) { rank = r; reasons.length = 0; }
    if (r === rank && r >= 2 && typeof output.reason === 'string' && output.reason.length > 0) {
      reasons.push(output.reason);
    }
    if (output.continue === false && !stop) {
      stop = true;
      if (typeof output.stopReason === 'string') stopReason = output.stopReason;
    }
    if (typeof output.additionalContext === 'string' && output.additionalContext.length > 0) {
      contexts.push(output.additionalContext);
    }
  }
  return {
    decision: rank === 3 ? 'deny' : rank === 2 ? 'ask' : rank === 1 ? 'allow' : 'none',
    reason: reasons.length > 0 ? reasons.join('\n\n') : undefined,
    stop,
    stopReason,
    additionalContext: contexts,
  };
}

// ─── legacy per-event mappers (v0.4.0/v0.8.0 tests rely on these) ───────────

/** PreToolUse mapping: exit 2 denies, hookSpecificOutput overrides, else allow. */
export function mapPreHookOutput(exitCode, stdout, { warn = console.warn } = {}) {
  if (exitCode === 2) {
    const reason = stdout.trim();
    return { kind: 'deny', reason: reason !== '' ? reason : 'blocked by hook' };
  }
  if (exitCode === 0) {
    let parsed;
    try { parsed = stdout.trim().startsWith('{') ? JSON.parse(stdout) : undefined; } catch { parsed = undefined; }
    const specific = parsed?.hookSpecificOutput;
    if (specific?.permissionDecision === 'deny') {
      return { kind: 'deny', reason: String(specific.permissionDecisionReason ?? (stdout.trim() || 'blocked by hook')) };
    }
    if (specific?.permissionDecision === 'ask') {
      return { kind: 'ask', reason: String(specific.permissionDecisionReason ?? 'hook requests approval') };
    }
    return { kind: 'allow' };
  }
  warn(`dsh-claude-compat: PreToolUse hook exited with code ${exitCode}, allowing`);
  return { kind: 'allow' };
}

/** PostToolUse mapping: exit 2 blocks with feedback; additionalContext injects. */
export function mapPostHookOutput(exitCode, stdout, { warn = console.warn } = {}) {
  if (exitCode === 2) {
    const text = stdout.trim();
    return { kind: 'block', feedback: [{ type: 'text', text: text !== '' ? text : 'blocked by hook' }] };
  }
  if (exitCode !== 0) {
    warn(`dsh-claude-compat: PostToolUse hook exited with code ${exitCode}, accepting`);
    return { kind: 'accept' };
  }
  const trimmed = stdout.trim();
  if (trimmed === '') return { kind: 'accept' };
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
  const additional = parsed?.additionalContext;
  if (typeof additional === 'string' && additional.length > 0) {
    return {
      kind: 'accept',
      additionalContexts: [createUserMessage({
        content: [{ type: 'text', text: additional }],
        source: { kind: CLAUDE_COMPAT_SOURCE_KIND, form: 'hook-context' },
      })],
    };
  }
  console.log(`dsh-claude-compat: PostToolUse hook stdout (logged, not injected): ${trimmed}`);
  return { kind: 'accept' };
}

// ─── listeners ──────────────────────────────────────────────────────────────

function contextMessage(texts) {
  if (texts.length === 0) return undefined;
  return createUserMessage({
    content: texts.map((text) => ({ type: 'text', text })),
    source: { kind: CLAUDE_COMPAT_SOURCE_KIND, form: 'hook-context' },
  });
}

/**
 * Register every hook listener. Config resolves per session workspace and is
 * cached (see `hooksForWorkspace`), so project-level hooks work even in a
 * desktop app whose process cwd is the profile directory.
 */
export function registerHooks(ctx, config) {
  const timeoutDefault = config.hooksTimeoutMs ?? 60_000;

  // Optional: the effective session directory (accounts for `cd`), else the
  // session's immutable header directory.
  const cwdOf = (agent) => {
    try {
      const wd = ctx.get?.('workingDirectory');
      if (wd !== undefined && agent?.session) {
        const committed = wd.get(agent.session);
        if (typeof committed === 'string' && committed !== '') return committed;
      }
    } catch { /* optional service */ }
    return agentCwd(agent);
  };

  /**
   * Run every command hook for `event` whose matcher selects `query` and fold
   * the outcomes. Async hooks run detached — they cannot decide anything.
   */
  async function runEvent(event, query, payloadFor, agent) {
    const cwd = cwdOf(agent);
    const { hooks } = hooksForWorkspace(cwd, config);
    const matched = hooks.filter((h) => h.event === event && matcherMatches(h.matcher, query));
    if (matched.length === 0) return { merged: mergeHookOutcomes([]), cwd };
    const outputs = [];
    for (const hook of matched) {
      const payload = payloadFor(cwd, hook);
      const run = runHookCommand(hook.command, payload, {
        cwd,
        env: { ...hook.env, CLAUDE_PROJECT_DIR: hook.env?.CLAUDE_PROJECT_DIR ?? cwd },
        timeoutMs: hook.timeoutMs ?? timeoutDefault,
      });
      if (hook.async === true) {
        run.then((result) => {
          if (result.exitCode !== 0) {
            console.warn(`dsh-claude-compat: async ${event} hook exited ${result.exitCode}: ${hook.command}`);
          }
        }).catch((error) => {
          console.warn(`dsh-claude-compat: async ${event} hook failed: ${String(error)}`);
        });
        continue;
      }
      const { exitCode, stdout, stderr } = await run;
      const decoded = decodeHookOutput({ exitCode, stdout, stderr }, event);
      // DSH logs the call before policy runs, so a rewritten input could not be
      // executed as logged; say so instead of pretending it applied.
      if (decoded.updatedInput !== undefined) {
        console.warn(`dsh-claude-compat: ${event} hook requested updatedInput, which is not honored (ignored)`);
      }
      outputs.push(decoded);
    }
    return { merged: mergeHookOutcomes(outputs), cwd };
  }

  // ── SessionStart → agent/created ──────────────────────────────────────────
  ctx.on('agent/created', (carrier, name, payload) => {
    const agent = carrier?.agent ?? payload?.agent;
    const source = typeof payload?.source === 'string' ? payload.source : 'startup';
    return runEvent('SessionStart', source, (cwd) => sessionStartPayload(agent, source, cwd), agent)
      .then(({ merged }) => {
        const context = contextMessage(merged.additionalContext);
        if (context !== undefined && typeof agent?.inject === 'function') agent.inject(context);
      })
      .catch((error) => console.warn(`dsh-claude-compat: SessionStart hook failed: ${String(error)}`));
  });

  // ── UserPromptSubmit → agent/pre-step ─────────────────────────────────────
  ctx.on('agent/pre-step', async (event, next) => {
    const { agent, messages } = event ?? {};
    const promptEmpty = !Array.isArray(messages) || messages.length === 0;
    if (!promptEmpty) {
      const { merged } = await runEvent(
        'UserPromptSubmit', '', (cwd) => promptPayload(agent, messages, cwd), agent);
      if (merged.decision === 'deny') {
        // A rejecting prompt hook removes the claimed input and blocks the turn.
        return { kind: 'reject' };
      }
      const downstream = typeof next === 'function' ? await next() : { kind: 'enter' };
      const context = contextMessage(merged.additionalContext);
      if (context === undefined || downstream.kind !== 'enter') return downstream;
      // Never short-circuit: a later listener still gets to reject the prompt.
      return { ...downstream, messages: [...(downstream.messages ?? []), context] };
    }
    return typeof next === 'function' ? next() : { kind: 'enter' };
  });

  // ── PreToolUse → tools/pre-execute ────────────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next) => {
    const { merged } = await runEvent('PreToolUse', exec?.name ?? '', (cwd) => preToolPayload(exec, cwd), exec?.agent);
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' };
    if (merged.decision === 'ask') return { kind: 'ask', ...(merged.reason !== undefined ? { reason: merged.reason } : {}) };
    return typeof next === 'function' ? next() : { kind: 'allow' };
  });

  // ── PostToolUse / PostToolUseFailure → tools/post-execute ─────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const failed = result?.isError === true || result?.error !== undefined;
    const event = failed ? 'PostToolUseFailure' : 'PostToolUse';
    const { merged } = await runEvent(event, exec?.name ?? '', (cwd) => postToolPayload(exec, result, event, cwd), exec?.agent);
    const context = contextMessage(merged.additionalContext);
    if (merged.decision === 'deny') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: merged.reason ?? `blocked by ${event} hook` }],
        ...(context !== undefined ? { additionalContexts: [context] } : {}),
      };
    }
    const downstream = typeof next === 'function' ? await next() : { kind: 'accept' };
    if (context === undefined) return downstream;
    const existing = Array.isArray(downstream.additionalContexts) ? downstream.additionalContexts : [];
    return { ...downstream, additionalContexts: [context, ...existing] };
  });

  // ── Stop → agent/turn-stopping ────────────────────────────────────────────
  ctx.on('agent/turn-stopping', async (event) => {
    const agent = event?.agent;
    const { merged } = await runEvent('Stop', '', (cwd) => stopPayload(agent, cwd), agent);
    if (merged.decision === 'deny' || merged.stop === true) {
      const text = merged.reason ?? merged.stopReason ?? 'continue: blocked by Stop hook';
      if (typeof agent?.steer === 'function') {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: CLAUDE_COMPAT_SOURCE_KIND, form: 'hook-context' },
        }));
      }
    }
  });

  // ── SubagentStart / SubagentStop → subagent/start, subagent/end ───────────
  const children = new Map();
  ctx.on('subagent/start', (info) => {
    let child;
    try { child = ctx.get?.('agents')?.get?.(info?.id); } catch { child = undefined; }
    if (child !== undefined) children.set(info?.runId ?? info?.id, child);
    return runEvent('SubagentStart', 'general-purpose', (cwd) => subagentPayload('SubagentStart', info, child, cwd), child)
      .then(({ merged }) => {
        const context = contextMessage(merged.additionalContext);
        if (context !== undefined && child !== undefined && typeof child.inject === 'function') child.inject(context);
      })
      .catch((error) => console.warn(`dsh-claude-compat: SubagentStart hook failed: ${String(error)}`));
  });

  ctx.on('subagent/end', (info) => {
    const key = info?.runId ?? info?.id;
    let child = children.get(key);
    children.delete(key);
    if (child === undefined) {
      try { child = ctx.get?.('agents')?.get?.(info?.id); } catch { child = undefined; }
    }
    return runEvent('SubagentStop', 'general-purpose', (cwd) => subagentPayload('SubagentStop', info, child, cwd), child)
      .catch((error) => console.warn(`dsh-claude-compat: SubagentStop hook failed: ${String(error)}`));
  });

  // ── SessionEnd → agent/disposed ───────────────────────────────────────────
  ctx.on('agent/disposed', (carrier, name, payload) => {
    const agent = carrier?.agent ?? payload?.agent;
    return runEvent('SessionEnd', '', (cwd) => sessionEndPayload(agent, cwd), agent)
      .catch((error) => console.warn(`dsh-claude-compat: SessionEnd hook failed: ${String(error)}`));
  });
}
