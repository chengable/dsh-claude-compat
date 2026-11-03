# 能力覆盖审计：skills / commands / agents / plugins

> 审计对象：`dsh-claude-compat`（把 Claude Code 的 `.claude/` 桥接进 DeepSeek Harness 的 DSH 插件）
> 审计范围：**只覆盖 skills、commands、agents、plugins 四类**，不含 hooks 与 MCP（另有人查）。
> 审计方式：源码逐行 + 本机真实 `~/.claude` 样本 + DSH 侧权威定义（官方文档与已安装运行时里的工具 schema）+ Claude Code 官方文档。
> 本文件只读产出，未修改任何代码。
>
> **行号快照说明**：`src/` 在本审计期间被并行修改（其他审计线在改代码），因此本报告的 `src/*.js:行号` 统一对应 **git `6356be0` + 2026-11-03 12:42 工作区** 的快照；若行号漂移，请按同行的函数名/代码片段搜索定位。`src/agents.js`、`src/plugins.js`、`src/plugin-manager.js`、`src/aliases.js`、`src/lib.js` 未随该波改动漂移，已复核一致。

---

## 0. 审计基线与样本

### 0.1 本机真实样本（下文"证据"列引用）

| 样本 | 实测结果 |
|---|---|
| `~/.claude/skills` | 36 个技能目录，全部 1 层深；0 个非 kebab 名；0 个缺 `description` |
| `~/.claude/commands` | 6 个平铺 `.md`（adhd / amux / any-story / commit / handoff / standup） |
| `~/.claude/agents` | **空目录** |
| `~/.claude/plugins/installed_plugins.json` | 18 条记录：17 条 `scope=user`，1 条仅 `project`（`hyperframes`），1 条同时有 `local`+`user`（`multica-cli`） |
| `~/.claude/settings.json` | `enabledPlugins` 17 项，其中 **`context-mode@context-mode: false`**（已禁用） |
| 插件 commands 文件 | 全机共 **43 个** `commands/*.md`；其中 **20 个含 `$ARGUMENTS`**、**24 个含 `argument-hint`**、**22 个含 `allowed-tools`**、**3 个含 `` !` `` bash 前缀**、**0 个含 `$1`/`$2`** |
| 插件/用户 SKILL.md | 全机 **453 个**；`allowed-tools` 39、`model` 24、`disable-model-invocation` 14、`user-invocable` 10、`when_to_use` **0** |
| 插件 agents | 全机 **47 个** `agents/*.md`；`tools` 37、`model` **42**、`color` 42、`skills:` 1 |
| 嵌套命令子目录 | 全机 **0 个**（`commands/dir/name.md` 这种命名空间布局当前无真实样本） |
| 深度 >3 的技能 | **0 个**（现有最深 3 层） |
| 插件根 `SKILL.md` | **0 个** |

### 0.2 DSH 侧权威定义（本报告最关键的三条）

1. **`skill` 工具只有 `name` 一个参数。** 从本机已安装运行时里解包出的 `@deepseek-ai/dsh-tool-skill/lib/index.js` 定义：
   ```js
   defineTool({ name: "skill", ..., parameters: { name: { type: "string", required: true, ... } }, ... })
   ```
   官方文档同述：*"The model-facing `skill({ name })` tool validates the kebab-case name…"*（[docs/subsystems/skills.md](https://raw.githubusercontent.com/deepseek-ai/DeepSeek-Harness/HEAD/docs/subsystems/skills.md)）。→ **不存在 arguments 通道。**
2. **`ctx.commands` 只能由插件在 `apply()` 期注册**，`CommandDefinition.name` 是"Lowercase command name without the leading slash"，只有 `input.hint`（占位文案）这一个非结构化输入描述符（[docs/subsystems/commands.md](https://raw.githubusercontent.com/deepseek-ai/DeepSeek-Harness/HEAD/docs/subsystems/commands.md)）。→ **DSH 没有"用户自建 markdown 斜杠命令"这一层**。
3. **DSH 原生 skill provider 明确不支持递归：** *"Nested recursive `**/SKILL.md` discovery is not supported."*（同上 skills.md）→ 本插件的递归是**补偿实现**，不是原生能力。

### 0.3 结论速览（按严重度）

| 级别 | 缺口 | 一句话 |
|---|---|---|
| 🔴 P0 | 命令参数通道完全缺失 | `$ARGUMENTS`（20/43 真实文件在用）被原样当正文喂给模型，永不展开 |
| 🔴 P0 | 插件 `commands` 数组形态不识别 | 实测丢了 `agent-skills` 的 **8 个**真实命令（含 1 个用 `$ARGUMENTS` 的） |
| 🟠 P1 | `enabledPlugins` 被发现链路完全忽略 | 已禁用插件仍被扫描，与 Claude Code 语义相反 |
| 🟠 P1 | 插件组件命名空间丢失 | Claude Code 是 `/plugin:skill`；本项目拉平成裸名 → 实测 `skill-creator` 跨两插件真冲突 |
| 🟡 P2 | agents 只映射成 skill，`model`/`tools` 不生效 | 42/47 真实 agent 声明了 `model`，全部丢弃；无独立上下文 |
| 🟡 P2 | 语义细节分歧（`skills` 字段是"追加"不是"替换"、无 description 的技能被丢弃、`when_to_use` 字段名读错） | 目前未爆，属潜伏正确性缺陷 |

---

## 1. A. Skills（`.claude/skills/**/SKILL.md`）

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议 |
|---|---|---|---|---|
| 项目 `.claude/skills` 扫描 | 读 `<cwd>/.claude/skills/<name>/SKILL.md` | **完整** | `src/index.js:398` `discoverSkills()`；`:275` 项目根定位；rank 50 使项目 .claude 全局胜出（`src/index.js:85`） | — |
| 用户 `~/.claude/skills` 扫描 | 读 `~/.claude/skills/**` | **完整** | `src/index.js:280` `addRootCandidates(userClaudeDir, …)`，rank 700；`src/lib.js:20` 展开 `~` | — |
| 插件 skills | 读各插件 `skills/`，按 `<plugin>:<skill>` 命名空间 | **部分** | 能扫（`src/plugins.js:100-102`），但**命名空间被丢弃**（见 D 节 P1） | 至少在 description 前缀插件名，便于用户辨认来源 |
| 嵌套目录（`skills/a/b/SKILL.md`） | 官方布局是 `skills/<name>/SKILL.md`；嵌套子目录按路径命名空间 `/apps/web:deploy` | **部分** | 本插件递归到 3 层并把路径拉平成 `a-b`（`src/index.js:405-417`，`if (depth >= 3) return` 在 `:417`）；README 亦声明（`README.md:143`）。DSH 原生不支持递归，故这是补偿实现；但拉平后的名字与 Claude Code 的 `:` 命名空间语义不同 | 保持现状即可（`:｀ 无法表达），在 README 说明"嵌套=拉平"已做 |
| frontmatter `name` | 目录名或 `name` 决定命令名 | **完整** | 优先 `name`，回退拉平目录名：`src/index.js:472`、`:481` | — |
| frontmatter `description` | **可省略**，省略时取正文首个非空行 | **部分（有分歧）** | 代码 `src/index.js:474` `if (description === undefined) return undefined;` → 整个技能被丢弃。Claude Code 明确回退非空首行（官方 skills 文档 frontmatter 表）。本机 453 个 SKILL.md 全部带 description，故今日未爆 | 补一个回退：取 body 首个非空行（`agents.js:70` 的 `firstLine()` 已有现成实现） |
| frontmatter `disable-model-invocation` | `true` = 模型不可自动加载 | **完整** | `src/index.js:592-594` `parseInvocationPolicy()`；真实样本 14 个在用 | — |
| frontmatter `user-invocable` | `false` = 只给模型用，隐藏 `/` 菜单 | **完整** | 同上 `:561` | — |
| frontmatter `when_to_use` | **下划线**字段名，追加到 description，与 description 合计 1536 字符上限 | **缺失（字段名读错）** | 代码读的是 camelCase `whenToUse`：`src/index.js:489`。Claude Code 官方字段为 `when_to_use`（"Field names use lowercase words separated by hyphens, except **when_to_use**"）。本机真实样本 0 个在用，故潜伏 | 两个 key 都读（`when_to_use` 优先），一行改动 |
| frontmatter `allowed-tools` | 该技能激活期间免确认使用指定工具 | **缺失（平台不支持）** | 39 个真实技能在用；DSH 的 skill candidate 无工具策略字段，`skill({name})` 只返回正文 | 见 §5 不可支持项；可选：把 `allowed-tools` 作为一行文本写进正文提示，让模型自觉（弱保证） |
| frontmatter `disallowed-tools` | 技能激活时移除工具 | **缺失（平台不支持）** | 同上，DSH 无对应通道 | 见 §5 |
| frontmatter `model` / `effort` | 技能激活期间切换模型/推理档位 | **缺失（平台不支持）** | 24 个真实技能在用；DSH skill 定义无 model 字段 | 见 §5 |
| frontmatter `context: fork` / `agent` / `background` | 在子代理上下文里执行技能 | **缺失（平台不支持）** | DSH 有 subagent 能力，但无"技能即 fork"的声明式通道 | 见 §5 |
| frontmatter `paths` | 按文件 glob 限制自动激活 | **缺失** | 本项目未读该字段；DSH 无"按路径激活技能"机制 | 低优先，见 §5 |
| frontmatter `arguments` / `$ARGUMENTS` 等在技能正文中的替换 | 正文里 `$ARGUMENTS`/`$N`/`$name` 在调用时展开 | **缺失（平台不支持）** | `src/index.js:372-380`：`get()` 只做 `parseFrontmatter(raw).body.trim()` 返回，无任何替换；`skill` 工具只有 `name` 参数 | 见 §5，P0 但**不可支持**，替代方案见下 |
| `` !`cmd` `` 动态上下文注入（技能内） | 发送给模型**之前**先跑命令，用输出替换该行 | **缺失（平台不支持）** | 同上：正文原样返回。模型能看到 `` !`cmd` `` 文本，可能自己去跑，但"先执行再注入"的语义丢失 | 见 §5 |
| `${CLAUDE_SKILL_DIR}` 等变量替换 | 正文与 allowed-tools 中替换为技能目录 | **部分（等价物存在但未替换）** | `get()` 返回 `resourceBase: {kind:'directory', path}`（`src/index.js:389` 附近），DSH 用它解析技能引用资源；但正文里的 `${CLAUDE_SKILL_DIR}` 字面量不替换 | 可在 `get()` 里做一次字符串替换（低风险、纯文本层） |
| 无 frontmatter / YAML 解析失败 | 技能仍加载，字段按空处理；只有 `---` 不在首行才当纯内容 | **缺失（有分歧）** | `src/lib.js:114` `parseFrontmatter()` 失败返回 `undefined`；`src/index.js:471` 直接 `return undefined` → **整个技能被丢弃**。Claude Code 是"照常加载，字段为空" | 改为：解析失败时把整文件当正文、`name` 回退目录名、`description` 回退首个非空行 |
| 名称规则（kebab-case） | `^[a-z0-9]+(?:-[a-z0-9]+)*$` | **完整** | `src/aliases.js:21`、`:54` `resolveCandidateName()`；与 DSH 语法一致 | — |
| 非 ASCII（中文）名称 | Claude Code 允许（名字不受 kebab 约束） | **部分（需手工配置）** | `src/aliases.js` 提供 `skillAliases` 映射；未映射的非 kebab 名会**被丢弃**并 warn 一次（`:85` `warnUnmapped`）。本机 36 个用户技能中 0 个非 kebab，故今日无实际损失 | 可选：未映射时自动生成 ASCII slug（如拼音/哈希），减少手工配置 |
| 优先级（项目 > 用户） | 项目 `.claude/skills` 胜过 `~/.claude/skills` | **完整** | rank 50 vs 700（`src/index.js:85-88`），registry 低 rank 先胜；`test/self-check.test.js:107` 已钉住 | — |
| 与 DSH 原生技能的优先级 | 无此概念 | **完整（有明确定义）** | 项目 .claude 50 > DSH native 100/200 > 自定义 300 > user-dsh 400 > user-agents 500 > bundled 600 > **~/.claude 700** > 插件 750（`src/index.js:38-39`、`:85-88`、`:117`） | 行为清晰，但"~/.claude 输给 DSH bundled"是反直觉点，README 已说明 |
| 技能正文 / 资源按需加载 | 正文只在调用时加载；支持引用附带文件 | **完整** | `get()` 惰性读盘（`src/index.js:372`）；返回 `resourceBase` + `path` | — |
| 目录名与 frontmatter name 冲突 | `name` 决定命令名，目录名也能调用 | **部分** | 只认一个赢家：`resolveCandidateName([fmName, flatName])` 取第一个合法名（`:448`），目录名的别名不额外注册 | 低优先；Claude Code 允许两种写法都能调用 |

---

## 2. B. Commands（`.claude/commands/*.md`）

> Claude Code 已把自定义命令**并入 skills 体系**：`.claude/commands/deploy.md` 与 `.claude/skills/deploy/SKILL.md` 等价，都产生 `/deploy`，frontmatter 字段相同（commands 不支持 `name` 与 `paths`）。因此本节的"Claude Code 行为"即技能/命令统一语义。

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议 |
|---|---|---|---|---|
| 项目 `.claude/commands/*.md` | 平铺 md → `/name` | **完整** | `src/index.js:429-465` `discoverCommands()`；`userInvocable: true`（`:422`）使 `/name` 出现在斜杠菜单 | — |
| 用户 `~/.claude/commands/*.md` | 同上 | **完整** | `src/index.js:280` 对用户目录同样调用 `addRootCandidates`；rank 700（项目胜） | — |
| 插件 commands | 扫描插件 `commands/`（manifest 可覆盖） | **部分** | 能扫（`src/plugins.js:103`），但：①数组/对象形态被忽略②空 description 有专门补丁（`:113-149`） | 见 D 节 P0「commands 数组形态」 |
| 命名空间子目录 `commands/dir/name.md` → `/dir:name` | 支持（`:` 命名空间） | **缺失** | `discoverCommands()` 只 `readdir` 一层且 `if (!entry.isFile() ...) continue`（`src/index.js:435`、`:438`）→ 子目录整棵跳过，连 warn 都没有。本机 0 个真实样本 | 递归并按 `dir-name` 拉平（与 skills 保持一致策略）；`:｀ 在 DSH 命令名里不可用 |
| `$ARGUMENTS`（全部参数） | 展开为完整参数字符串；无占位符时自动追加 `ARGUMENTS: <值>` | **缺失** | 全机 20/43 个命令文件在用；`src/index.js:372-380` 无替换；`skill` 工具无参数通道 | 见 §5 + 下方「可行的替代设计」 |
| `$ARGUMENTS[N]` / `$N`（位置参数） | `$0` 第一个、`$1` 第二个；支持引号分组；缺参时占位符原样保留 | **缺失** | 同上，src 内无任何 `ARGUMENTS` 处理（grep 仅命中 `commands.js:170/176` 的提示文案） | 同上 |
| `$name`（`arguments:` frontmatter 命名参数） | 按 `arguments` 列表位置映射 | **缺失** | 未读 `arguments` 字段 | 同上 |
| `` !`bash` `` 前缀（命令内预执行） | 命令正文送模型**之前**执行，输出替换占位符；多行用 ```! 块 | **缺失** | 全机 3 个真实样本（`openai-codex` 的 result/status/cancel.md）；正文原样返回给模型 | 见 §5 |
| `@file` 引用 | 命令中 `@path` 预读文件内容 | **缺失** | src 无解析；且 Claude Code 现代实现主要用 `!`/skill 引用，`@` 语义已弱化 | 低优先 |
| frontmatter `description` | 描述；省略时取正文首行 | **完整** | `src/index.js:449` 回退到文件名 stem | — |
| frontmatter `argument-hint` | 自动补全时显示参数提示 | **缺失** | 24/43 真实文件在用；代码只读 `description`（`src/index.js:449`） | 若能把命令注册成原生 DSH 命令，可映射到 `input.hint`（`commands.js:99` 已有该用法） |
| frontmatter `allowed-tools` | 免确认使用指定工具 | **缺失（平台不支持）** | 22/43 真实文件在用；DSH 无通道 | §5 |
| frontmatter `model` | 命令生效期间切模型 | **缺失（平台不支持）** | DSH 无通道 | §5 |
| frontmatter `name` / `paths` | commands **不支持**这两个字段 | **完整（同为不支持）** | 代码不读 → 行为一致 | — |
| `disable-model-invocation` / `user-invocable` | 控制调用方 | **部分** | 命令候选**硬编码** `{modelInvocable:true, userInvocable:true}`（`src/index.js:455`），完全不读 frontmatter；所以对 commands 写 `disable-model-invocation: true` 无效 | 让 commands 也走 `parseInvocationPolicy()`（与 skills 一致） |
| 命令作为原生斜杠命令（零 token） | 宿主直接执行，不进模型历史 | **缺失** | 只有 5 个内置管理命令是原生命令（`src/commands.js:97-179`：cc-plugin/cc-resume/cc-export/reload-cc-plugins/reload-skills）。`.claude/commands/*.md` 全部只能走 skill 路径，必然消耗模型 token | 见下方「可行的替代设计」 |

### 可行的替代设计（针对 `$ARGUMENTS`）

虽然 `skill` 工具没有 arguments 通道，但 DSH 的 `ctx.commands` 可以注册**带 `rawInput` 的原生命令**，且 handler 能拿到 `agent` 与 `rawInput`（`src/commands.js:89-186` 已是现成范例，`ctx.inject(['commands'], …)` 是官方守卫写法）。可行路径：

1. 启动时把 `.claude/commands/**.md` 的**名字集合**注册成原生 DSH 命令（`name` 必须是 kebab，见 §5）；
2. handler 里按 `agent.session.header.cwd` 重新读该 md，把 `$ARGUMENTS` / `$N` / `$name` 替换成 `rawInput`，再 `agent.steer(createUserMessage(...))` 注入（`src/commands.js:137-140` 已有 steer 范例）；
3. 这样 `$ARGUMENTS` 语义**可以恢复**，代价是命令名集合是进程级的，而 `.claude/commands` 是工作区级的——需要"启动时扫一遍注册全集 + handler 内按时校验"或提供退化入口。

> 注意：DSH 命令名是"lowercase without leading slash"，`:` 不能用于命名空间；插件命名空间只能拉平成 `-`。

---

## 3. C. Agents（`.claude/agents/*.md`）

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议 |
|---|---|---|---|---|
| 项目 `.claude/agents/*.md` | 子代理定义，可被 Task 工具委派 | **部分（映射为 skill）** | `src/agents.js:23-68`；`src/index.js:334-346` 把 agents 目录并入候选。README 明确这是"delegation shim"（`README.md:62`） | 设计取舍已在 README 说明，可接受；但见下方 `model`/`tools` |
| 用户 `~/.claude/agents` | 用户级子代理 | **完整（本机为空）** | 同一代码路径；本机 `~/.claude/agents` 空目录 → 0 贡献 | — |
| 插件 agents | 读 `<plugin>/agents/*.md` | **部分** | 硬编码 `join(installPath,'agents')`（`src/plugins.js:105`），**完全忽略 manifest `agents` 字段**。本机 14 个插件 agent 被正确发现；但 `agent-skills` 声明的正是该目录下的 4 个文件，属"碰巧一致" | 读 manifest `agents`（注意 Claude Code 规定它是 **.md 文件**列表，**不接受目录**） |
| frontmatter `name` | 必填，唯一标识；不得含 `:` | **完整** | `src/agents.js:42` `resolveCandidateName([fmName, stem])` | — |
| frontmatter `description` | 必填；决定何时委派 | **完整** | `src/agents.js:47-49`；同时复用为 `whenToUse`（`:56`） | — |
| frontmatter `tools` | 限定子代理可用工具 | **缺失（仅文本提示）** | 47 个真实 agent 中 37 个声明 `tools`；代码只在正文前插一行 `Tools: …`（`src/agents.js:52`、`:64`、`:81`），**无任何强制** | 见 §5（DSH skill 无工具策略）；可考虑真做成 subagent preset |
| frontmatter `model` | 指定子代理模型（sonnet/opus/inherit/全 ID） | **缺失** | 47 个真实 agent 中 **42 个**声明 `model`，代码完全不读（`discoverAgents` 无该字段） | 至少把 `model:` 写进 delegation 头文本，让模型调 subagent 时带上 `model` 覆盖（DSH subagent 支持 agentOptions） |
| frontmatter `color` | 任务列表/transcript 里的显示色 | **缺失（无害）** | 42 个真实 agent 在用；DSH catalog 无颜色概念 | 可忽略 |
| frontmatter `skills:`（预载技能） | 子代理启动时把整段技能正文注入上下文 | **缺失** | `codex-rescue.md` 真实在用（`skills: [codex-cli-runtime, gpt-5-4-prompting]`）；代码不读 | 低优先，可在 delegation 头里列出"先加载这些技能" |
| 独立上下文窗口 / 真正的子代理隔离 | 子代理拥有独立上下文、独立模型、独立工具集 | **缺失** | 只映射成 skill：模型加载正文后**在主上下文里**扮演该 agent（`src/agents.js:18` `AGENT_HEADER` 只是文字指令）。无 spawn、无上下文隔离 | 中期：把 `.claude/agents/*.md` 注册成 DSH `agentPreset`/subagent backend（DSH subagent 有 `agentPreset` 能力位），才能拿到真正的隔离与 model/tools 生效 |
| 同名 agent 跨项目/用户优先级 | 高优先位置胜出 | **完整** | rank 50 vs 700 + registry 去重；`src/agents.js:6-7` 注释即此设计 | — |
| 插件 agent 命名空间 `/plugin:agent` | 命名空间 | **缺失** | 同 D 节 P1；本机 14 个 agent 名无跨插件冲突（潜伏） | 同 D 节 |
| `enableAgents: false` 关闭 | — | **完整** | `src/index.js:341`、`:303`、`src/plugins.js:104`；`test/v101.test.js`/`v040` 有覆盖 | — |

---

## 4. D. Plugins（插件生态）

### 4.1 发现与清单

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议 |
|---|---|---|---|---|
| `.claude-plugin/plugin.json` 定位 | `<pluginRoot>/.claude-plugin/plugin.json` | **完整** | `src/plugins.js:151-158` `readPluginManifest()` | — |
| `plugin.json` `name` | 必填，kebab；**所有组件都挂在它下面做命名空间** | **部分** | 只用于拼 key/来源标签，**命名空间未生效**（见下） | 见 P1 命名空间 |
| `plugin.json` `version` / `description` / `author` | 元数据 | **部分** | 仅 `version` 从 `installed_plugins.json` 读到（`:52`），清单里的 `version/description/author` 不参与任何输出 | 低优先：可把 `plugin@version` 写进 catalog 的 description 便于溯源 |
| `plugin.json` `skills` | 路径或路径数组；**"Adds to the default `skills/` scan"**（追加，不替换） | **部分（语义反了）** | `src/plugins.js:180-182` `return declared.length > 0 ? declared : [join(installPath,'skills')]` = **声明即替换**。4 个插件声明了该字段；本机因声明目录恰好覆盖默认目录，**今日无实际丢失**，但语义与 Claude Code 相反 | 改成"默认 `skills/` + 声明目录"取并集（1 行改动） |
| `plugin.json` `commands`：字符串 | 路径，**替换**默认 `commands/` 扫描 | **完整** | `src/plugins.js:189-191` | — |
| `plugin.json` `commands`：**数组** | 路径数组，替换默认扫描 | **缺失（真实内容丢失）** | `src/plugins.js:190` 只判 `typeof === 'string'`，数组落到默认 `join(installPath,'commands')`。实测 `agent-skills@addy-agent-skills` 声明 `['./.claude/commands','./commands']`，其 `<ip>/commands` 里只有 **8 个 `.toml`**（Codex 格式，非 md），真实命令在 `<ip>/.claude/commands/*.md`（8 个）→ **8 个命令全部丢失**，其中 `build.md` 用 `$ARGUMENTS`。`test/v101.test.js:86` 只测了字符串形态 | **P0 修复**：`manifestDirs()` 已支持数组（`:160-167`），`pluginCommandsDir` 复用它即可 |
| `plugin.json` `commands`：**对象**（name→source/content 映射） | 支持 | **缺失** | 未处理；本机无样本 | 低优先 |
| `plugin.json` `agents` | **.md 文件**路径或数组；**不接受目录**；替换默认 | **缺失** | 代码恒用 `<ip>/agents` 目录（`src/plugins.js:105`），从不读 `agents` 字段。本机 `agent-skills` 声明的 4 个文件恰在默认目录 → 碰巧正确；若声明在别处则丢失 | 读 `agents` 字段（文件列表，逐个读或取其共同父目录） |
| `plugin.json` `hooks` / `mcpServers` | 见各自文档 | **不在本审计范围** | — | 由 hooks/MCP 审计方负责 |
| `plugin.json` `defaultEnabled` | 用户未在 `enabledPlugins` 表态时的默认启用值 | **缺失** | 未读；发现链路恒把插件当启用 | 与下一条一起修 |
| 插件根 `SKILL.md`（"a single skill at the plugin root"） | 支持，名字取 frontmatter `name` | **缺失** | `pluginSkillDirs()` 只返回 `skills/` 或声明目录（`src/plugins.js:180-182`），从不看 `<ip>/SKILL.md`。本机 0 个真实样本 | 低优先，可加一次 stat |
| 嵌套插件包（`<ip>/plugins/<sub>/` 自带 `.claude-plugin/plugin.json`） | 由 marketplace 各自登记 | **缺失（边缘）** | 实测 `minimax-skills` 的 `plugins/pptx-plugin` 含 **5 个 skills + 5 个 agents**，但 `installed_plugins.json` 未单独登记它，发现链路也不递归 → 10 个组件不可达 | 边缘场景；至少 warn 一次"发现未登记的内嵌插件" |

### 4.2 marketplace 结构与安装状态

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议 |
|---|---|---|---|---|
| `installed_plugins.json` 读取 | 记录安装位置与 scope | **完整** | `src/plugins.js:32-56`；同 key 取最后一条（`:44` `findLast`），与本机"重装追加记录"的真实格式一致 | — |
| `cache/<market>/<name>/<version>/` 结构 | 版本目录，`installPath` 指向具体版本 | **完整** | 代码直接用 record 的 `installPath`，不自己拼版本路径 → 抗版本命名变化。注意：`find ~/.claude/plugins/cache -maxdepth 3 -name plugin.json` 得 0 是**正常**的（真实深度是 `cache/<market>/<name>/<version>/.claude-plugin/plugin.json` = 5 层） | 排查文档可补一句，避免误判 |
| scope 过滤（user / project / local） | 三种 scope 都会生效 | **部分（只认 user）** | `src/plugins.js:44` 仅取 `scope === 'user'`。实测：`hyperframes@hyperframes` 只有 `project` 记录 → **整个插件被丢弃**；`multica-cli` 有 `local`+`user`，user 生效 | 至少把 `project`/`local` 也纳入（按 cwd 匹配 project） |
| `enabledPlugins`（`~/.claude/settings.json`） | 用户启用/禁用的**唯一真相**；禁用插件不加载任何组件 | **缺失（P1）** | 发现链路**从不读 settings.json**：`src/plugins.js` 全文无 `settings.json`/`enabledPlugins`。全仓唯一读取处是 `src/plugin-manager.js:110`（且只用于 `/cc-plugin list` 的显示）与 `:198-209`（写状态用）。实测 `context-mode@context-mode` 在 `enabledPlugins` 中为 `false`，但 `readInstalledClaudePlugins()` 仍返回它 | **P1 修复**：`readInstalledClaudePlugins()` 读同目录 `../settings.json` 的 `enabledPlugins`，`false` 的跳过（缺省视为启用，兼容 `defaultEnabled`） |
| 禁用插件"是否仍被扫描" | **不加载** | **缺失（同 P1）** | 同上。当前 `context-mode` 恰好 0 技能（其 `skills/` 不在常规位置），故**今日无可见污染**；一旦该插件恢复常规布局就会静默出现 | 同 P1 |
| `blocklist.json` | Anthropic 侧黑名单 | **缺失（无影响）** | 本机 `blocklist.json` 只有 2 条测试项（`code-review@claude-plugins-official`、`fizz@testmkt-marketplace`） | 可忽略 |
| `known_marketplaces.json` / `marketplaces/` | 市场登记与本地克隆 | **完整（用于搜索）** | `src/plugin-manager.js:130-155` `searchMarketplaces()` 读 `marketplaces/<name>/.claude-plugin/marketplace.json` | — |

### 4.3 启用/禁用/安装/卸载/更新

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议 |
|---|---|---|---|---|
| `/plugin install` | 走市场、写 cache+registry | **部分** | `src/plugin-manager.js:289-303`：优先 `claude plugin install`（`:60-64`），失败回退自实现 `fallbackInstall()`（`:162-195`，含备份）。回退引擎要求市场仓库已克隆 | 可接受；README/Troubleshooting 已提示 |
| `/plugin uninstall` | 卸载 | **部分** | 透传 `claude plugin uninstall`（`:262`）；**无回退实现**（回退分支只对 enable/disable 开放，`:278-282`） | 补 `fallbackUninstall`（删 cache 目录 + 清 registry 条目 + 清 enabledPlugins） |
| `/plugin enable|disable` | 改 `enabledPlugins` | **完整** | CLI 优先，ENOENT 时回退 `fallbackToggle()`（`:198-209`），改前备份 | 注意：**写了 `enabledPlugins` 但发现链路不读**（P1），所以"禁用后仍在 catalog 里"——这是 P1 的用户可见症状 |
| `/plugin update` | 更新单/全部 | **部分** | 仅透传 CLI（`:268-272`），无回退 | 低优先 |
| `/plugin marketplace add|remove|update` | 市场管理 | **部分** | 仅透传 CLI；失败时明确报"回退未实现，需手工 git clone"（`:251-258`） | 已有诚实提示，可接受 |
| `/plugin search` | 搜索市场 | **完整** | `searchMarketplaces()`（`:130-155`）扫所有已克隆市场的 `marketplace.json` | — |
| 备份安全 | — | **完整** | 所有直接改文件前 `backupFile()` 时间戳备份（`:70-75`），CLI 路径完全不碰文件 | 值得保留 |
| 后端引擎 | — | **部分** | 依赖外部 `claude` CLI；CLI 不可用时只有 install/enable/disable 有回退 | 已在 README Troubleshooting 说明 |
| 更新后刷新 catalog | — | **完整** | `/reload-cc-plugins` → `control.invalidate()`（`src/index.js:357`、`src/commands.js:91-94`） | — |

### 4.4 命名空间与冲突（P1）

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议 |
|---|---|---|---|---|
| 插件组件命名空间 | *"Claude Code namespaces every component under it, so an agent reviewer in plugin deploy-tools appears as `deploy-tools:reviewer`"*；插件技能是 `/plugin-name:skill-name`，**裸名也能调**除非冲突 | **缺失** | 候选名就是裸名（`src/plugins.js:101-107` 直接用各 discover 的返回值），无任何插件前缀。跨插件同名 → 全插件同 rank 750，靠 `installed_plugins.json` 顺序 first-wins | 至少在 description 前加 `[plugin-name]`；若要彻底解决需 DSH 支持带 `:` 的名字（见 §5） |
| 实测冲突 | 两个都可用（命名空间隔离） | **部分（真冲突）** | 复现脚本按本仓命名逻辑重算 17 个 user-scope 插件 → 100 个不同技能名，其中 **`skill-creator` 同时存在于 `document-skills@anthropic-agent-skills` 与 `skill-creator@claude-plugins-official`**，`skill-creator@claude-plugins-official` 在 registry 中先出现、胜出；`document-skills`（无清单，走默认 `skills/` 扫到 19 个）里的同名技能被挤掉 | 同上；或改成"同名时后者不覆盖但 warn" |

---

## 5. 平台限制导致的不可支持项

> 以下不是本项目"忘了做"，而是**当前 DSH 运行时没有承载通道**。已逐条验证（取证方式见 §0.2），建议在 README 的 Known limitations 里统一列出，避免用户误判为 bug。

| # | 不可支持项 | 为什么（DSH 侧事实） | 影响面（真实样本） | 可做的折衷 |
|---|---|---|---|---|
| 1 | **`$ARGUMENTS` / `$ARGUMENTS[N]` / `$N` / `$name` 参数替换** | `skill` 工具 schema 只有 `{ name: string }`，模型调 `skill` 时**无处传参**；注册表 `get(candidate, options)` 也不收参数。DSH 的 `CommandInvocation` 有 `rawInput`，但那是**原生命令**通道，不是 skill 通道 | 20/43 个真实命令文件依赖 `$ARGUMENTS`；用户敲 `/commit --style=full` 时参数**直接丢失**（正文里的 `$ARGUMENTS` 原样进上下文） | ①对高频命令用 `ctx.commands` 注册原生命令 + handler 内替换（`src/commands.js` 已有全套范例，风险低但命令名为进程级）；②或在 description/正文顶部注明"参数请直接写在消息里" |
| 2 | **`` !`cmd` `` 预执行 / ```! 块** | skill 正文是**纯文本**返回给模型，DSH 不会在返回前执行命令 | 3 个真实命令（`openai-codex`）+ 大量真实技能 | 模型看到 `` !`cmd` `` 后通常会自己调 bash，语义近似但**执行时机/权限不同**；可在 README 说明"会由模型自己执行，不再预执行" |
| 3 | **`@file` 引用预读** | 同上，正文原样返回 | 少量 | 同上 |
| 4 | **`allowed-tools` / `disallowed-tools`（技能与命令）** | DSH skill candidate 无工具策略字段；`skill` 工具返回的只有 `<skill_content>`，不改变权限上下文 | 39 个技能 + 22 个命令 | 只能写进正文当"建议"，无强制力。可考虑与 DSH 权限系统对接（工程量大，需平台侧支持） |
| 5 | **技能/命令的 `model` / `effort` 覆盖** | DSH skill 定义无 model 字段；模型由会话决定 | 24 个技能 + 22 个命令 | 无；README 说明 |
| 6 | **`context: fork` / `agent` / `background`（技能内 fork 子代理）** | DSH 有 subagent 能力，但**没有"技能声明式 fork"**的通道；需插件主动 `startActivation` | 真实样本较少 | 中期可做：把 agents 变成真 subagent preset（见 C 节） |
| 7 | **`paths`（按文件 glob 激活技能）** | DSH 无此激活维度 | 少量 | 无 |
| 8 | **技能 `hooks` 字段** | 平台 hooks 归 DSH 自己的 hooks 体系（且本次范围外） | 少量 | 由 hooks 审计方评估 |
| 9 | **插件组件命名空间 `/plugin:skill`** | DSH skill 名语法 `^[a-z0-9]+(?:-[a-z0-9]+)*$` **不允许 `:`**；命令名亦"lowercase without leading slash" | 跨插件同名（实测 1 例 `skill-creator`；潜伏更多） | 用 `-` 拉平（`plugin-skill`）或仅在 description 标注来源；完全等价不可支持 |
| 10 | **`skill` catalog description 长度** | DSH 侧 `catalogDescriptionMaxLength` 默认 **500** 字符；Claude Code 是 description+when_to_use 合计 1536 | 实测 4 个真实技能描述超 500（genoffice 905、diagram-suite 815、llm_wiki 788、html-ppt 616）→ catalog 里被截断，可能削弱触发准确率 | 把关键触发词放描述**最前面**；或调大 DSH 侧配置 |
| 11 | **DSH 无自有 MCP 配置源**（仅记录，不在本次范围） | 插件声明的 MCP 必须由桥接层翻译后挂载；DSH 本身只认挂载的 client 实例 | 详见 MCP 审计 | 由 MCP 审计方负责 |

---

## 6. 修复建议（按性价比排序）

| 序 | 改动 | 成本 | 收益 | 位置 |
|---|---|---|---|---|
| 1 | `pluginCommandsDir()` 支持 `commands` **数组**（复用现成的 `manifestDirs()`） | ~3 行 | 立即恢复 `agent-skills` 的 **8 个真实命令**；同时修对象形态的入口 | `src/plugins.js:189-191` |
| 2 | `readInstalledClaudePlugins()` 读 `settings.json` 的 `enabledPlugins`，跳过 `false`（缺省视为启用），顺带支持 `defaultEnabled` | ~15 行 | 与 Claude Code 语义对齐；`/cc-plugin disable` 立刻"真的"生效 → 消除用户可见矛盾 | `src/plugins.js:32-56` |
| 3 | `pluginSkillDirs()` 改为"默认 `skills/` ∪ 声明目录" | ~2 行 | 与 Claude Code "adds to default scan" 对齐，避免插件升级后新增技能静默消失 | `src/plugins.js:180-182` |
| 4 | `discoverCommands()` 让 commands 走 `parseInvocationPolicy()`，不再硬编码 | ~2 行 | 让 `disable-model-invocation` 对 `.claude/commands` 生效 | `src/index.js:455` |
| 5 | 读 manifest `agents` 字段（文件列表），替换硬编码 `<ip>/agents` | ~10 行 | 修正语义；避免声明在非默认位置时丢 agent | `src/plugins.js:104-107` |
| 6 | 技能缺 `description` / frontmatter 解析失败时**不丢弃**，回退正文首个非空行 | ~10 行 | 消除"静默丢技能"；`firstLine()` 已有现成实现可复用 | `src/index.js:467-474`、`src/agents.js:70` |
| 7 | 兼容 `when_to_use`（下划线）字段名 | ~1 行 | 修掉字段名读错的潜伏 bug | `src/index.js:489` |
| 8 | plugins 纳入 `project`/`local` scope | ~10 行 | 找回 `hyperframes` 这类 project-scope 插件 | `src/plugins.js:44` |
| 9 | 插件候选一律在 description 前加 `[plugin-name]` | ~3 行 | 缓解命名空间丢失导致的来源不明/冲突（`skill-creator` 案例） | `src/plugins.js:88-94` |
| 10 | `discoverCommands()` 递归子目录并拉平（`dir-name`） | ~10 行 | 对齐 Claude Code 命名空间子目录（本机暂无样本，属前瞻） | `src/index.js:429-465` |
| 11 | agents 的 `model`/`skills:` 写入 delegation 头文本 | ~5 行 | 42/47 真实 agent 的 model 不再静默丢失；模型调 subagent 时可带 model 覆盖 | `src/agents.js:79-85` |
| 12 | （中期）把 agents 映射为真 subagent preset | 大 | 拿到真正的上下文隔离 + tools/model 生效 | 需平台 subagent API |
| 13 | （中期）高频 `.claude/commands` 注册为原生 DSH 命令，handler 内做 `$ARGUMENTS` 替换 | 中大 | 唯一能恢复参数语义的路；还能零 token | `src/commands.js` 扩展 |

---

## 7. 已做对、不需动的地方（避免过度修改）

- 优先级阶梯定义清晰且被真实 registry 测试钉住（`test/self-check.test.js:107-111`）：project .claude 50 > DSH native > ~/.claude 700 > plugin 750。
- `disable-model-invocation` / `user-invocable` 的解析与布尔宽松处理（`src/index.js:592-599`、`:601-609`）符合 Claude Code（文档明确接受 `yes/no/on/off/1/0`）。
- 非 kebab（中文）名称的 `skillAliases` 策略 + 一次性 warn，是当前平台下**唯一正确**的做法，且保持 rank 参与去重。
- 插件清单**缺字段**时回退常规布局（`skills/`、`commands/`）——v1.0.1 已修，避免了 claude-mem 那类 22 技能全丢。
- 插件目录用 `installPath` 而非自拼版本路径，抗 `cache/<market>/<name>/<version>` 命名变化。
- 所有直接改 Claude 文件的路径都有时间戳备份（`src/plugin-manager.js:70-75`）。
- `ctx.inject(['commands'], …)` 守卫写法使旧宿主/无命令服务宿主可静默降级（`src/commands.js:90`）。

---

## 8. 附：本报告用到的复现命令

```bash
# 1) 插件清单真实深度（maxdepth 3 得 0 是正常的）
find ~/.claude/plugins/cache -maxdepth 3 -name plugin.json | wc -l   # 0
find ~/.claude/plugins/cache -maxdepth 5 -name plugin.json | wc -l   # 61

# 2) enabledPlugins 里已禁用但仍在 registry 的插件
python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/settings.json')))['enabledPlugins']['context-mode@context-mode'])"
# → False，但 installed_plugins.json 里 context-mode 仍是 scope=user

# 3) manifest commands 数组形态（真实内容丢失）
IP=~/.claude/plugins/cache/addy-agent-skills/agent-skills/fefc4075ddfd
python3 -c "import json;print(json.load(open('$IP/.claude-plugin/plugin.json'))['commands'])"
ls "$IP/commands"          # 只有 8 个 .toml（代码只认 .md → 0 个）
ls "$IP/.claude/commands"  # 真正的 8 个 .md —— 全部丢失

# 4) scope 只认 user 导致整插件丢失
python3 -c "
import json,os
d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json')))
for k,v in d['plugins'].items(): print(k,[e.get('scope') for e in v])"
# hyperframes@hyperframes -> ['project']  → 被丢弃

# 5) skill 工具无参数通道（从已安装运行时解包）
#    见 @deepseek-ai/dsh-tool-skill/lib/index.js:
#    parameters: { name: { type: 'string', required: true } }

# 6) 平台文档确认递归不支持 / skill({ name })
curl -sL https://raw.githubusercontent.com/deepseek-ai/DeepSeek-Harness/HEAD/docs/subsystems/skills.md | grep -n "Nested recursive"
curl -sL https://raw.githubusercontent.com/deepseek-ai/DeepSeek-Harness/HEAD/docs/subsystems/commands.md | grep -n "Lowercase command name"
```
