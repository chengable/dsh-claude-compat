# 更新日志

[English](CHANGELOG.md) | 简体中文

本项目所有重要变更记录于此。版本遵循 [SemVer](https://semver.org/)。

## [1.1.2] — 2026-11-03

### 修复
- **hook 提示不再带终端颜色转义。** claude-evol 的审查提醒带着 `\u001b[1m\u001b[93m`，直接投递会在会话里显示成乱码。现在按 Claude Code 的做法，在展示前剥掉颜色码。

## [1.1.1] — 2026-11-03

### 新增
- **hook 的输出现在能在会话里看到。** Stop hook 的纯 stdout（以及显式的 `systemMessage` 字段）就是 Claude Code 显示出来的那种 hook 提示，claude-evol 的「以下 N 个会话已达审查阈值」正是如此。DSH 没有 hook 输出的展示通道，所以桥把这段文本缓冲到**下一条 prompt**，以 `form: 'notice'` 的用户消息投递。之所以在轮次边界缓冲、而不是当场注入，是因为在 `agent/turn-stopping` 注入会让本已结束的轮次继续保持打开。新增 `surfaceHookOutput`（默认 `true`）可关闭。

### 修复
- **失败的 hook 不再静默。** 退出码既不是 0（成功）也不是 2（故意拦截），说明 hook 自己坏了；Claude Code 会把它报出来，而这里保持安静会让"升级后坏掉的插件"和"正常工作但没做事"完全无法区分。现在会打一条 non-blocking 告警。
- **插件 MCP 的 server 名补上 Claude Code 的 `plugin_` 段**：`mcp__plugin_<plugin>_<server>__<tool>`。permission 规则与 hook matcher 都是按这个全名写的，之前 `mcp__<plugin>_<server>__<tool>` 的形态永远匹配不上。

### 测试
- 新增 hook 输出的解码与合并用例（`test/v110.test.js`）；套件共 97 项，全部通过。

## [1.1.0] — 2026-11-03

### 新增
- **Claude Code hooks 现在原生运行，不需要再装第二个插件。** 桥接 DSH 有接缝的全部九个事件：`SessionStart`（注入上下文）、`UserPromptSubmit`（拦截 / 追加上下文）、`PreToolUse`（deny / ask）、`PostToolUse` 与 `PostToolUseFailure`（拦截 / 追加上下文）、`Stop`（强制继续）、`SubagentStart` / `SubagentStop`、`SessionEnd`。来源包括 `~/.claude/settings.json`、`<项目>/.claude/settings.json`、`<项目>/.claude/settings.local.json`，以及每个已安装插件的 `hooks/hooks.json`（或其 manifest `hooks` 字段声明的文件）—— 插件 hooks 此前完全不可见，这也是 claude-mem 这类插件在这里从来跑不起来的原因。插件 hook 的 `${CLAUDE_PLUGIN_ROOT}` 会被替换，并导出给子进程。
- **hook 语义对齐 Claude Code。** payload 带齐真实字段（`session_id`、`transcript_path`、`cwd`、`hook_event_name` 及各事件字段）与结尾换行；命令在会话工作目录运行并导出 `CLAUDE_PROJECT_DIR`；matcher 用 Claude 的规则（纯单词与 `|` 视为字面量或，其余按非锚定正则）；决策映射与参考实现一致（exit 2 拦截且 stderr 作为原因、`hookSpecificOutput.permissionDecision` 取 allow/deny/ask、`additionalContext` 注入、`continue: false` 停止、`async: true` 分离执行）。`Notification`、`PreCompact`、`Setup` 没有对应接缝，会被明确报告而不是静默丢弃。
- **MCP：完整的 Claude Code 作用域层级。** 依次收集 local（`~/.claude.json` → `projects[<路径>].mcpServers`）、project（`.mcp.json`）、user（`~/.claude.json` → `mcpServers`）与插件 server，并按 Claude Code 的优先级合并（高作用域整条覆盖）。插件 server 命名空间为 `plugin_<插件>_<server>`，这样为 Claude Code 写的 permission 规则与 hook matcher 仍能对上。

### 修复
- **桌面版里项目级 hooks 与 `.mcp.json` 一直静默不可见。** 两者都从 `process.cwd()` 解析，而 DSH 宿主是从 profile 目录启动的 —— 于是项目的 `.claude/settings.json` 与 `.mcp.json` 永远找不到，且没有任何日志。现在两者都从**会话工作目录**解析；启动时没有会话则由第一个会话补上。
- **hook 配置按工作区读取并缓存**，`/reload-cc-plugins` 会失效缓存；改 settings 或装插件不再需要重启进程才能看到（此前只在激活时读一次）。
- **MCP 变量展开**：`${VAR}`、`${VAR:-default}`、`${CLAUDE_PROJECT_DIR}`、`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}` 会在 command/args/env/url/headers 中展开，并带 Claude Code 的防护：远程 url/headers 里的凭证类变量读为空。manifest 内联 `mcpServers` 此前整条绕过了替换（与 1.0.2 起的 CHANGELOG 承诺相反）。
- **此前被忽略的 MCP 字段**：`timeout`（原来硬编码 60 秒）、`disabled`，以及 DSH 没有的传输 —— `ws`/`sdk` 告警后跳过，旧 `sse` 告警后按 streamable-http 挂载，`url` 没写 `type` 会告警而不是静默挂载。
- **MCP 冲突变确定**：模块级挂载登记表 + 串行挂载，取代两路不 await 的并发挂载，项目 server 与插件 server 不会再重复注册同名；超长 server 名截断时带哈希，避免两个长名撞成同一个。
- **插件 `commands` 数组形态此前被忽略** —— 一个真实插件声明 `["./.claude/commands", "./commands"]`，导致它 8 个命令全丢。现在 skills/commands/agents 都支持数组；manifest 的 `skills` 字段改为**追加**到约定的 `skills/` 扫描，而不是替换。
- **`enabledPlugins: false` 生效**，`/cc-plugin disable` 现在真的会禁用插件（技能、命令、agent、hooks、MCP server 全部）；只有 project 作用域安装记录的插件也不再被丢弃。
- **`.claude/commands` 现在遵循 `disable-model-invocation` 与 `argument-hint`**；使用 `$ARGUMENTS` 的命令会说明参数该写在哪，而不是把字面占位符漏给模型。
- **没有 `description` 的技能不再被丢弃**（用正文首行作描述，与 Claude Code 一致），并同时读取 `when_to_use` 与 `whenToUse`。
- **`.claude/agents` 不再只有正文**：委派头里带上 agent 的 `model`、`tools`、`skills`。

### 测试
- 新增 `test/v110.test.js`（hooks：来源、插件发现、工作区解析、payload、解码、合并）、`test/v111.test.js`（MCP：变量展开、传输、作用域、优先级、命名空间）、`test/v112.test.js`（插件组件、`enabledPlugins`、命令参数、agent 头）。套件共 96 项，全部通过。

## [1.0.4] — 2026-11-03

### 测试
- **`npm run check` 现在在任意机器上都是绿的。** `test/v050.test.js` 里有两个用例断言的是真实 `~/.claude/plugins` 安装内容（注册表里必须有 `oh-my-claudecode`，且从中发现 ≥40 个技能、≥20 个命令、≥15 个 agent），于是在任何没装这个插件的机器上，套件都是红的 —— 每次回答「测试过了吗」都得补一句「除了两个环境依赖失败」。现在两个用例都在临时目录里自建 plugins 根与插件，完全按 Claude Code 实际写入的布局（`<root>/installed_plugins.json` 加 `<root>/cache/<marketplace>/<name>/<version>`），断言同样的阈值、同样的候选形状、以及同样的跨类同名规则（`skills/ask` 与 `commands/ask.md` 各自保留）。顺带把此前没有覆盖的注册表边界情况钉住：重装后最后一条 `user` 记录生效、`project` 作用域记录被跳过、缺少 `installPath` 的记录被丢弃、key 中没有 `@` 时 marketplace 为空；`enableAgents: false` 隐藏 agents 也有了覆盖。没有任何用例读本机真实 `~/.claude`，所以换台机器一样绿，也不会因为插件升级或卸载而腐坏。

## [1.0.3] — 2026-11-03

### 变更
- **`enablePluginMcp` 默认值改为 `true`。** 此前要挂载已安装 Claude Code 插件声明的 MCP server，必须在 profile 的 `cordis.patch.yml` 里写一行配置。而 profile 的 patch 行不会随插件重装保留 —— patch 层被修复或替换后，插件会静默回到「不挂载插件 MCP」，且没有任何提示。现在这个期望直接落在 schema 默认值里，装完即生效。想要关闭，显式设 `enablePluginMcp: false`。

### 测试
- 新增 `test/v103.test.js`：锁住各项默认值（`enablePluginMcp`、`projectRootMarkers`、技能与规则开关），确保重装不会把它退回「需要手工开启」的状态。

## [1.0.2] — 2026-11-03

### 修复
- **插件 MCP server 现在按 Claude Code 支持的全部三种写法发现。** `translatePluginMcp()` 此前只认 manifest 里 `mcpServers` 为**路径字符串**的写法；其它形态一律产出 0 个 server、0 条告警。而多数市场上插件把 server 写在独立的 `<installPath>/.mcp.json` 里（claude-mem 的 `mcp-search` 正是如此），内联 `mcpServers` 对象同样合法 —— 两种都被丢弃，于是 `enablePluginMcp: true` 实际上什么都没挂上。现在的解析顺序是：内联对象 → 路径字符串 → 约定文件 `<installPath>/.mcp.json`，三种情况都会替换 `${CLAUDE_PLUGIN_ROOT}`。畸形的 `mcpServers` 值、以及声明了但读不到的路径，现在会告警而不是静默消失；完全没有 MCP 配置的插件仍然安静地解析为 0 个 server。

### 测试
- 新增 `test/v102.test.js`：覆盖 claude-mem 那种布局（manifest 无 `mcpServers` + 独立 `./.mcp.json`）、内联对象、路径字符串优先级、`${CLAUDE_PLUGIN_ROOT}` 替换、路径不可读告警、畸形值告警，以及显式空表。

## [1.0.1] — 2026-11-03

### 修复
- **非 git 工作目录下项目级发现不再整体消失。** `findProjectRoot()` 在逐级向上直到文件系统根仍未命中标记时返回 `undefined`，于是 `list()` 与 rules 注入器直接跳过 `<projectRoot>/.claude/{skills,commands,agents,rules}` —— 没有条目、也没有告警。Claude Code 本身不要求这一点：`claude` 在普通目录里同样读取 `.claude/`。现在两个函数在无标记命中时回退到会话 cwd，与 DSH 自身 `dsh-skill-filesystem` 的项目根规则一致。`projectRootMarkers` 默认值同时补上 `CLAUDE.md`，这样会话开在子目录里也能定位到项目根。
- **插件 manifest 省略 `skills` / `commands` 字段时，不再把这个插件的内容整块吞掉。** 发现逻辑把「字段存在但为空」当成「这个插件什么都没声明」，于是所有依赖约定目录的市场上插件贡献 0 个技能，且完全静默：`claude-mem` 的 22 个技能、以及 `skill-creator`、`plugin-dev`、`agent-morph`、`claude-evol`、`codex`、`minimax-skills`、`minimalist-entrepreneur` 的技能都因此丢失。现在字段缺省即表示 `<installPath>/skills` / `<installPath>/commands`，与「无 manifest」分支及 Claude Code 的可选字段语义一致。新增导出的 `pluginSkillDirs()` / `pluginCommandsDir()`，把这条规则纳入单测。
- 进程级的 `.mcp.json` 挂载显式退出 cwd 回退（`fallbackToCwd: false`）：它保持根作用域，因为 DSH 进程可能从任意目录启动。
- `/cc-export` 对无标记目录现在报 `No DSH skills in <dir>`，而不再是 `No project root found (no .git)` —— 这种目录现在就是它自己的项目根。

### 测试
- 新增 `test/v101.test.js`：标记回退（同步 + 异步）、最近标记优先、`CLAUDE.md` 作为默认标记、`fallbackToCwd: false`、插件技能/命令目录规则（有/无/已声明/空数组）、仅取 user 作用域的安装记录，以及一个针对「manifest 无 skills 字段」的 `discoverPluginContent` 端到端用例（缺 DSH peer 包时自动跳过）。

## [1.0.0] — 2026-10-30

### 新增
- **发布至 DSH 插件市场。** 仓库现托管市场索引 `site/index.json`，由 `.github/workflows/market.yml` 部署到 GitHub Pages。在 DSH 插件市场的「发现」标签页添加索引源 `https://biedongbin.github.io/dsh-claude-compat/index.json`，即可浏览并安装全部版本。`scripts/update-market-index.mjs` 从 npm registry 再生索引（规则与官方生成器一致：未弃用且声明 `dsh.bundle` 的版本）；已列出的版本跨重跑保留，`npm publish` 后重跑并提交即可收录新版。0.9.2 曾打包但从未推送 npm——registry 从 0.9.1 直接跳到 1.0.0。

## [0.9.2] — 2026-10-28

### 新增
- **管理面升级为 DSH 原生 slash 命令**（`/cc-resume`、`/cc-plugin`、`/cc-export`、`/reload-cc-plugins`、`/reload-skills`）。DSH 的 `@deepseek-ai/dsh-commands` 服务（随官方 Web 宿主内置）允许插件注册**宿主直接执行**的人类命令：用户提交 slash 行后 handler 在 DSH 进程内运行，结果文本由 UI 直接渲染——命令的发现、执行与输出**不消耗任何模型 token**、绝不进入模型历史（每次运行以 log-only 的 `command/run`+`command/done` 事件对记入会话日志）。handler 直接 spawn 本包 CLI（`scripts/cc-resume.mjs`、`scripts/cc-export.mjs`），并以 `--cwd` 钉死**会话**工作目录（宿主进程 cwd 不是工作区）；`/cc-plugin` 复用 `runPluginCommand`；reload 命令直接调 skill registry 的 `control.invalidate()`。注册走运行时守卫 `ctx.inject(['commands'], …)`——与官方内置 `dsh-plan-mode` 完全同款——无该服务的宿主（UI-less spine、ACP 自动化、旧版本）静默回落到 skill 路径。回归由 `test/v092.test.js` 覆盖。

### 变更
- **五个管理技能退出用户 slash 菜单**（`userInvocable: false`，保持 `modelInvocable: true`）：人类入口收敛为原生命令，菜单里每个功能只剩一条（不再命令 + 模型中介技能并列）；模型仍保留可加载的说明书作为回落面。

## [0.9.1] — 2026-10-28

### 修复
- **管理技能目录可见但永远加载失败（`skill "cc-plugin" is unknown or no longer available`）** —— 波及全部五个 inline 技能（`/cc-plugin`、`/reload-cc-plugins`、`/reload-skills`、`/cc-resume`、`/cc-export`）。DSH registry 加载定义的唯一通道是 `provider.get(candidate)`，candidate 自带的 `get()` 闭包永远不会被调用；这五个技能的 body 恰恰埋在这种闭包里，locator 又存着 `import.meta.url`（`file://` URL），`provider.get()` 照着它读盘 —— `readTextSafe(file://…)` 返回 `undefined`，registry 于是报技能不存在。闭包还带着两处连带缺陷：返回 `{ body }` 而 `validateDefinition` 要求 `{ content }`；`/reload-cc-plugins` 的缓存刷新（`control.invalidate()`）也埋在闭包里，reload 从未真正刷新过。现在 body 与 invalidate 标志随 locator 传递（`{ kind: 'inline', body, invalidate }`），`provider.get()` 对 inline 候选直接返回定义、在加载时触发 `invalidate()` —— 加载 reload 技能即完成刷新。同时了结 0.7.0 的「已知问题」：根因是本插件的死闭包，并非 DSH 运行时分层。回归由 `test/v060.test.js` 与 `test/self-check.test.js`（真 `SkillRegistry` 加载断言）覆盖。
- **`/cc-plugin` HELP 文案通篇写 `/plugin`**，与实际技能名 `/cc-plugin` 不一致；已统一，且 Execution 段明确指示模型经 bash 运行 `claude plugin <args>`（`runPluginCommand` 没有 DSH tool 挂载，skill body 是唯一执行通路）。

### 工具
- **npm 包只发布运行时脚本**。`files` 此前整目录收录 `scripts/`，把仅维护者使用的工具（`deploy-local.sh` —— checkout→profile 部署，错误提示硬编码 macOS app 路径，别处无意义；`gen-downloads-chart.mjs`）一并带了出去。现改为逐个列举安装后真正需要的四个：`cc-resume.mjs`、`cc-export.mjs`、`zstd-compat.mjs`、`dsh-restart.sh`（`bin` 用）。两个开发脚本仍留在仓库，仅瘦身发布包。

## [0.9.0] — 2026-10-28

### 新增
- **`skillAliases`：让中文（及任何非 ASCII）技能名可用**。DSH 的技能名文法固定为 kebab-case（`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，定义在 `@deepseek-ai/dsh-skill`，registry 在 `get()` 取用前先校验），中文名在插件层放行也没用 —— 下一层必然 `return void 0`，所以此前只能整条丢弃。现在可以显式映射成合法 slug：`skillAliases: { "三脑": "san-nao" }`，原名保留在描述最前（`三脑 — …`，可用 `aliasDescriptionPrefix: false` 关掉）。映射同时作用于 skills / commands / agents / 插件技能。合法名永远压过映射，别名沿用原 provider 的 rank，与 DSH 原生或 `~/.agents` 同名时按原有优先级去重。回归由 `test/v090.test.js` 覆盖。

### 修复
- **非 kebab 名技能被静默丢弃**：`skills`、`commands`、`agents`、插件命令四处都是裸 `continue`，用户只能靠翻源码才知道哪个技能没进来。现在每个文件每进程告警一次，并直接给出可粘贴的 `skillAliases` 示例。

### 工具
- **`scripts/deploy-local.sh`**：把本仓库 `src/` 同步进已安装的 DSH profile（`~/.dsh/profiles/<profile>/node_modules/dsh-claude-compat`），并留一份带时间戳的备份。DSH 在进程启动时 import 的是安装副本，直接改 checkout 不生效。（`bash scripts/deploy-local.sh --help`。）由 PR #3 贡献。

_贡献者 @liujunctz123-jpg（PR #3）。_

## [0.8.4] — 2026-10-18

### 修复
- **dsh 0.2.0 下新会话无法加载（`format v4 message requires a producer-owned source kind`）**：会话格式 v4 准入（`session-format-v3-to-v4/src/message-sources.ts`）拒绝退役的 V3 包装 `source.kind: 'plugin'` —— 第三方生产者须声明自有 kind。三处注入点（`index.js` 的 rules、`hooks.js` 的两处 hook-context）仍在发旧包装，故凡含 `.claude/rules/*.md` 的项目，新会话在加载阶段即被拒。现改发 `source.kind: 'plugin:dsh-claude-compat'` 并删去 `plugin` 字段 —— 此值正是 dsh 自身 `producerKind()` 为我们推导的结果（不在 `RENAMED_PRODUCERS`/`RELEASED_SAME_NAME_PRODUCERS` 中 → `plugin:${plugin}`），故 0.8.3 写下的、经 dsh 迁移的旧日志与今日新写的消息收敛于同一值。判重逻辑改为比对共享常量 `CLAUDE_COMPAT_SOURCE_KIND`。回归由 `test/v080.test.js` 覆盖，并对真实准入谓词验证于 `test-evidence/verify-084-v4-admission.mjs`。对应 Issue #2。

## [0.8.3] — 2026-09-30

### 修复
- **rules 判重扫描用错了事件查询 API**：pre-step 钩子取一次 `snapshotEvents()` 快照后按 surface 的 seq 索引（`events[seq]`）。快照数组下标与会话 seq 并不保证对齐（dsh 有 `firstLiveSeq`/偏移语义），防重复注入检查可能静默落空。现改用 `session.eventAt(seq)` — dsh 核心自身做 surface 扫描所用的精确查询 API — 并保留 `session.events?.[seq]` 回退以兼容 0.1.2 之前宿主。基于 @SvenKunkka 的 PR #1。

## [0.8.2] — 2026-09-30

### 修复
- **dsh 升级后会话档案无法加载（`cannot safely transform unclassified message source`）**：插件注入的消息携带自定义 `source.kind: 'claude-compat'`，不在 dsh 迁移器白名单（`SOURCE_KINDS`）内，凡含此类消息的会话日志在 v0→v3 迁移时 fail-closed 拒载。注入来源（`index.js` 的 rules、`hooks.js` 的 hook-context）改为白名单内的 `kind: 'plugin'` + `plugin: 'dsh-claude-compat'` — 与 dsh 核心插件（`@deepseek-ai/dsh-system-prompt`、`user-approval`）已写入的形态一致。防重复注入的回读检测同步改为匹配新标识。

## [0.8.1] — 2026-09-08

### 修复
- **resume 崩溃（`Cannot read properties of undefined (reading '7')`）**：rules 的 `agent/pre-step` 钩子索引 `agent.session.events[seq]`，但 dsh 0.1.2-rc.1 的 `Session` 没有 `events` 属性 — 公开 API 是 `snapshotEvents()`。resume 时 surface 非空，`.some()` 回调首次执行即抛，本轮以 `code UNKNOWN` 失败。钩子改为循环外取一次 `snapshotEvents()` 快照再索引。新会话不受影响（空 surface 短路）。

## [0.8.0] — 2026-08-19

### 新增
- **会话生命周期 hooks**：`SessionStart` → `agent/session-start`，`SessionEnd` → `agent/disposed`。fire-and-forget（尽力而为，非零退出仅告警，不阻塞循环）。载荷含 `session_id` + `cwd`。
- **`/cc-export`**：把 DSH 原生 skill（`.dsh/skills`）导出为 Claude Code `.claude/skills/<name>/SKILL.md`，frontmatter 保留；多行值输出为 YAML literal block。`list` / `export [--overwrite] [--target]`。

### 修复
- **session hook agent 提取**：DSH agent 事件 dispatch `(carrier, name, payload)`，agent 在**第一个参数**（`carrier.agent`）而非 payload — 已在隔离沙箱实测。监听器改为 `carrier?.agent ?? payload?.agent`（防御 agent-loop 的 fused-payload 路径）。此前 `session_id` 恒为 `'unknown'`。

## [0.7.0] — 2026-08-18

### 新增
- **`/cc-resume` — Claude Code 会话恢复**：列出 `~/.claude/projects/<munged-cwd>/*.jsonl` 中的会话（id、日期、消息数、首条用户消息预览、已导入标记），可将任意会话导入 DSH，生成原生事件日志（`~/.dsh/sessions/<munged>/session-cc-<id>/session.jsonl.zstd`）。导入会话完整保留 user/assistant/工具调用历史，以 `cc: <预览>` 标题出现在 DSH 会话列表，可像原生会话一样打开续聊。
- 翻译规则：仅主线程（跳过 Claude sidechain 子代理消息）；丢弃 thinking 块（DSH reasoning 基于流式 chunk）；tool_use/tool_result 配对为 DSH `tool/call`/`tool/result` 事件；`--limit-turns N` 只导超大会话的最近 N 轮；重复导入幂等。
- **zstd frame 布局修复**：会话 header 行独立压缩为第一个 zstd 帧（DSH 的 `assertZstdHeaderFrame` 要求），事件体随后为第二帧 — 此前整包单帧压缩导致 DSH 解析导入日志失败。
- `scripts/cc-resume.mjs` 亦可独立作为 CLI 使用（`list` / `import <sessionId>`）；需要 PATH 上有 `zstd` 二进制。

### 已知问题
- `skill` 工具在 agent scoped 运行层可能无法解析插件提供的 skill（报 `unknown or no longer available`），即使 catalog 列表里存在 — 属 DSH 运行时分层行为。`/cc-resume` 可优雅降级：直接运行 `scripts/cc-resume.mjs`（skill 本体只是 CLI 的包装说明）。**0.9.1 已解决 —— 根因是本插件永不被调用的 inline 闭包，并非 DSH。**

## [0.6.2] — 2026-08-18

### 变更
- **内置命令重命名**：`/plugin` → `/cc-plugin`，`/reload-plugins` → `/reload-cc-plugins`。通用名 `plugin` 易与 DSH 原生或第三方 skill 冲突；`cc-` 前缀明确标识 Claude Code 桥接命令。`/reload-skills` 保留为别名。

### 新增
- **`scripts/dsh-restart.sh`** — 可移植、安全的 DSH Web 重启脚本，含幂等 terminal-bash 提示词补丁：
  - 零硬编码用户路径：经 PATH、nvm 或 npx 缓存（`~/.npm/_npx/*/node_modules/.bin/dsh`）自动发现 `dsh`。
  - 补丁机器上**所有**已安装的 `dsh-terminal-bash` 副本。
  - 跨平台 `sed`（GNU/BSD）、SIGKILL 兜底、启动崩溃检测、`--no-patch` 模式、`DSH_RESTART_PORT` 覆盖。
  - 随 npm tarball（`files`）发布，bin 别名 `dsh-claude-compat-restart`。
- README：内置命令章节、`enablePluginManager`/`pluginManagerRank` 配置项、故障排查章节（中英双语）。

## [0.6.1] — 2026-08-18

### 新增
- **`/reload-cc-plugins`（原 `/reload-plugins`）与 `/reload-skills`** — catalog 热重载。加载 reload skill 定义即触发重载：`get()` 调用 provider control 的 `invalidate()`，递增 registry revision、清空 collect 缓存、广播 `skills/change`，Web GUI 技能选择器**在当前会话**内刷新 — 无需重启、无需新会话。插件自带的 MCP server 仍需进程重启。

## [0.6.0] — 2026-08-18

### 新增
- **`/cc-plugin`（原 `/plugin`）— 完整的 Claude Code 插件与 marketplace 管理**，作为用户可调用的 DSH skill：
  - 子命令对齐 `claude plugin`：`list`、`install <name>[@marketplace]`（支持一步式 `/cc-plugin name@market`）、`uninstall`、`enable`、`disable`、`update [name]`、`search <term>`、`marketplace list|add|remove|update`。
  - 执行引擎：**claude CLI 优先**（PATH 有 `claude` 时走 `claude plugin ...`），不可用时**自实现兜底**（直接操作 JSON + git）— 每个被修改的文件均生成带时间戳的备份。
  - 所有状态保存在 Claude 原生位置（`~/.claude/plugins/installed_plugins.json`、`known_marketplaces.json`、`~/.claude/settings.json` 的 `enabledPlugins`），Claude Code 与 DSH 读同一份真相；新装插件内容经现有发现桥接呈现。
  - 管理器封闭测试套件（`test/v060.test.js`）；对 `claude` 2.1.220 完成 install → disable → enable → uninstall 全生命周期实测。

## [0.5.1] — 2026-08-17

### 修复
- **插件返回非 Promise 对象导致 MCP 挂载崩溃**：真实 cordis 中 `ctx.plugin()` 返回 Fiber（PromiseLike），但测试/嵌入环境可能返回普通对象。`.catch` 调用改为 `typeof fiber.catch === 'function'` 守卫而非默认假定。同时升版本号以击穿 pnpm tarball 缓存（同名 `.tgz` 更新会保留过期完整性校验）。

## [0.5.0] — 2026-08-17

### 新增
- **插件 marketplace 支持**：读取 `~/.claude/plugins/installed_plugins.json`（v2 注册表），呈现每个已装插件的 skills、commands、agents — 以 manifest（`.claude-plugin/plugin.json`）驱动，无 manifest 插件回退目录扫描。内容落在 rank `750`（长尾层：项目 `.claude`、DSH 原生、`~/.claude` 在同名冲突时均优先）。
- **插件 MCP 挂载（可选）**：`enablePluginMcp: true` 时插件 manifest 中的 `mcpServers` 翻译为 `dsh-mcp-client` 实例；`${CLAUDE_PLUGIN_ROOT}` 替换为安装路径。

## [0.4.0] — 2026-08-16

### 新增
- **`.mcp.json` 挂载**：项目根的 MCP server 定义在 DSH 启动时翻译为 `dsh-mcp-client` 插件实例 — `command` → stdio，`url` → streamable-http。畸形条目或缺客户端包降级为警告，不崩溃。进程启动时从启动工作区读取一次；修改后需重启生效。
- **Claude Code hooks 子集**：`PreToolUse` → `tools/pre-execute`（exit 2 = 拒绝），`PostToolUse` → `tools/post-execute`（exit 2 = 阻断），`UserPromptSubmit` → `agent/pre-step`。匹配器支持精确名、`*` 通配、`|` 分隔多选；命令经 `/bin/sh -c` 执行，stdin 收 Claude 风格 JSON 载荷；支持 `hookSpecificOutput.permissionDecision` 覆盖；超时放行并告警。
- **`.claude/agents/*.md` 垫片**：DSH 无 markdown 子代理格式，每个 agent 文件转为 delegation 垫片 **skill**（模型与用户均可调用，`/agent-name` 可用）。frontmatter `name` 须为 kebab-case，否则用文件名；`description` 映射 `whenToUse`。同名 agent 与 skill 一样按 rank 去重。

## [0.3.0] — 2026-08-15

### 新增
- **用户级 `~/.claude/` 支持**：除项目外，同时拾取家目录下的 skills、commands、rules 及 `settings.json` hooks。去重优先级修正：**项目 `.claude`（rank 50）> DSH 原生（100–600）> `~/.claude`（700）**。与项目 rule 同名的用户 rule 跳过。

## [0.2.0] — 2026-08-14

### 新增
- **`dsh.bundle` 声明**一键激活：`dsh plugin --profile web add dsh-claude-compat` 自动激活插件 — 无需手编 `cordis.patch.yml`。

## [0.1.0] — 2026-08-13

### 新增
- 首个版本：将 Claude Code 的项目 `.claude/` 桥接进 DeepSeek Harness。
  - `skills/**/SKILL.md` → DSH skill provider（catalog 名称/描述，正文按需加载）。
  - `commands/*.md` → 用户可调用 skill（斜杠菜单里 `/command-name`）。
  - `rules/*.md` → 消息流注入：拼接后包 `<system-reminder>` 信封，每会话前置一次 — 与 Claude Code 同一通道（`prependUserContext`），模型遵循可靠。

[0.8.1]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.5.1...v0.6.2
[0.6.1]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/biedongbin/dsh-claude-compat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/biedongbin/dsh-claude-compat/releases/tag/v0.1.0
