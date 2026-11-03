# MCP 能力覆盖审计：dsh-claude-compat vs Claude Code

审计范围：**只审计 MCP 能力覆盖面**（配置位置与作用域、传输类型、变量展开、字段、生命周期、工具命名与冲突、优先级合并）。
审计时点：2026-11-03 12:40，仓库 v1.0.3（`~/.dsh/profiles/{desktop,web}` 部署副本 `src/mcp.js` 与仓库 md5 相同，行为一致）。

> 行号说明：审计期间 `src/index.js` 有并发改动（新增 `enablePluginHooks` 配置等，MCP 相关语义未变），本文行号已按 12:40 的文件状态对齐。若后续 `src` 继续变动，请以文中给出的**函数名/配置键名**为准锚点（如 `mountPluginMcp()`、`translatePluginMcp()`、`enablePluginMcp`），行号仅作快速定位参考。

证据来源：

- 本仓库代码：`src/mcp.js`、`src/plugins.js`、`src/index.js`、`src/lib.js`（只读，未改动任何 `src`）
- Claude Code 官方文档：<https://code.claude.com/docs/en/mcp.md>（下文简称 **CC-DOC**，标注章节名）
- DSH 平台事实：<https://github.com/deepseek-ai/DeepSeek-Harness/blob/HEAD/docs/subsystems/mcp.md>（**DSH-MCP**）、`packages/mcp/mcp-client/README.md`（**DSH-CLIENT**）、`docs/config-catalog.md`（**DSH-CATALOG**）
- 本机真实样本：`~/.claude.json`、`~/.claude/plugins/cache/thedotmack/claude-mem/13.34.2/.mcp.json`
- 行为实测：用仓库源码 + /tmp 临时 fixture 跑 `translateMcpServers` / `translatePluginMcp` / `findProjectRootSync`（结果见文末「附录 A」）

## 0. 结论摘要

| 级别 | 缺口 | 一句话影响 |
|---|---|---|
| ★★★ 严重 | 桌面 app / 任意非项目 cwd 下，项目 `.mcp.json` **静默完全不挂载** | 项目作用域整体失效，且没有一行日志 |
| ★★★ 严重 | `${VAR}` / `${VAR:-default}` / `${CLAUDE_PROJECT_DIR}` / `${CLAUDE_PLUGIN_DATA}` **一处都不展开** | 真实的 `.mcp.json`（token、url 变量）到 DSH 里是字面量，server 起不来或鉴权失败 |
| ★★★ 严重 | **用户级 / 本地作用域完全不读**：`~/.claude.json` 的顶层 `mcpServers` 与 `projects[<path>].mcpServers` | 用户级 MCP（含 `claude mcp add` 的默认写入位置）永久丢失 |
| ★★ 重要 | 插件 MCP 工具名缺 `plugin_<plugin>_` 段；`serverName` 32 字符截断可撞名；跨来源同名不去重 | CC 里写好的 permission 规则 / hook matcher / `allowed-tools` 对不上；同名时后加载者直接加载失败 |
| ★★ 重要 | `timeout`、`disabled`、`type`（sse / ws / sdk）语义全部被忽略 | 超时固定 60s；关不掉的 server；SSE/WS 端点被当 HTTP 硬挂 |
| ★★ 重要 | 无优先级/合并：两个挂载调用竞态、去重集合是**每次调用新建的** | 「项目 vs 插件」谁赢取决于 async 完成顺序 |

最容易修的两个：**① `timeout` → `toolCallTimeoutMs`（1 行）**；**② 插件 inline `mcpServers` 漏替换 `${CLAUDE_PLUGIN_ROOT}`（1 行，且与 CHANGELOG 1.0.2 的承诺相反）**。次易修：`${VAR}`/`${VAR:-default}` 展开（纯函数、可单测）、`serverName` 截断加哈希后缀、`mounted` 集合提到模块级。

---

## 1. 配置位置与作用域

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议改法 |
|---|---|---|---|---|
| 项目 `<root>/.mcp.json` | 项目根 `.mcp.json`，读取前有 trust/approval 流程（CC-DOC §Project scope、§Project server approvals and workspace trust） | **部分（桌面 app 下实际 = 缺失）**：能从 `process.cwd()` 向上找 root，但 `fallbackToCwd:false`，找不到 marker 就**静默返回** | `src/mcp.js:93-96`；`src/lib.js:31`（markers = `.git`/`CLAUDE.md`）；实测：DSH desktop host 进程 cwd = `~/.dsh/profiles/desktop`，向上无 marker → `undefined`（附录 A-1） | 改用会话 cwd（`agent.session.header.cwd`）在会话创建/切换时挂载；至少 `console.warn` 一次「未找到项目根，跳过 .mcp.json」 |
| 用户级 `~/.claude.json` 顶层 `mcpServers`（`claude mcp add -s user`） | 全项目可用（CC-DOC §User scope；写入位置见 §MCP installation scopes 表） | **缺失**：代码里没有任何路径读 `~/.claude.json` | `grep -rn "claude.json" src/` 无结果；`src/mcp.js:89-107` 只读 `<root>/.mcp.json` | 读 `cfg.userClaudeDir`（已有配置项）外的 `~/.claude.json`，取 `mcpServers`；与项目级按 §7 优先级合并 |
| 本地作用域 `~/.claude.json` → `projects[<abs path>].mcpServers`（`claude mcp add` **默认**写这里） | CC-DOC §Local scope：默认 scope，按项目私有存储，示例 JSON 见该节 | **缺失** | 同上；本机样本 95 个 project 记录里均有 `mcpServers` 键（本机 0 个非空），结构真实存在（附录 A-2） | 同上，按 `process.cwd()` 或会话 cwd 精确匹配 `projects[<path>].mcpServers` |
| 插件 `plugin.json` 内联 `mcpServers` | CC-DOC §Plugin-provided MCP servers 明确支持 inline | **部分**：能读出 server，但 `${CLAUDE_PLUGIN_ROOT}` **不替换**（走的是 `JSON.stringify` 后直接 `translateMcpServers` 的分支，绕过了 `fromText`） | `src/plugins.js:214-216`；与 `CHANGELOG.md:23` 的承诺（"substituted in every case"）矛盾；实测 inline 的 command 仍是 `${CLAUDE_PLUGIN_ROOT}/servers/db-server`（附录 A-3） | inline 分支也走 `fromText`（先把对象序列化再统一替换），或改成递归替换字符串值 |
| 插件根 `<installPath>/.mcp.json`（约定） | CC-DOC 同上（claude-mem 就是这个布局） | **部分**：仅当插件有可读的 `.claude-plugin/plugin.json` 才走到约定分支；**没有 plugin.json 的插件被整个跳过**（`index.js` 先 `continue`，`translatePluginMcp` 的 `manifest === undefined` 分支永远到不了） | `src/index.js:200-203`（`raw === undefined` → `continue`）；`src/plugins.js:228-230`（该分支实际是死代码） | `index.js` 里去掉提前 `continue`，把 `manifest`（可为 `undefined`）直接交给 `translatePluginMcp`；这正好是 v1.0.1 为 skills 做过的同类修复 |
| 插件 manifest `mcpServers` 为**路径字符串** | 相对插件根解析 | **完整** | `src/plugins.js:217-221`；实测解析正确（附录 A-3） | 保留；补 `${CLAUDE_PLUGIN_ROOT}` 之外的变量 |
| agent / subagent frontmatter 内联 `mcpServers` | CC-DOC §Which variables a helper can read 附近提到「an inline server in an agent file」；subagent 可绑定专属 MCP | **缺失**：`src/agents.js` 只取 name/description/tools 等，无视 `mcpServers` | `src/agents.js`（全文无 mcp 关键字）；`grep -rn mcp src/agents.js` 无结果 | 至少在解析 agent 时告警「inline mcpServers 未支持」；完整支持需按 agent 作用域挂 mcp-client（见 §8） |
| 托管配置 / `--mcp-config` / claude.ai connectors | CC-DOC §Scope hierarchy and precedence 第 4、5 项与 `managedMcpServers` | **缺失** | — | 不在桥接职责内；明确写入 README「不支持清单」即可（见 §8） |

## 2. 传输类型

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议改法 |
|---|---|---|---|---|
| stdio（`command`/`args`/`env`） | 默认类型；`type` 缺省即 stdio（CC-DOC §Option 1 的警告） | **完整** | `src/mcp.js:50-58` | — |
| HTTP / `streamable-http` | `type: "http"`，且接受 `streamable-http` 作为别名（CC-DOC §Option 1） | **完整** | `src/mcp.js:59-65` → `transport: 'streamable-http'`；DSH-CATALOG 只有 `'stdio' \| 'streamable-http'` | — |
| 旧 SSE（`type: "sse"`） | 支持但已弃用；HTTP 优先、必要时回落 SSE（CC-DOC §Option 2） | **缺失（平台限制）**：DSH 根本没有 SSE transport，本项目把 `type:'sse'` 一律翻成 `streamable-http`，**翻译期不告警** | `src/mcp.js:66-68` 只在「type 是 sse 但没有 url」时告警；有 url 时落入 `:59` 分支；DSH-CATALOG 的 `transport` 联合类型无 sse | 翻译期对 `type:'sse'` 明确 warn（"legacy SSE unsupported by DSH, mounting as streamable-http; the server must accept POST/GET on one endpoint"）；README 写进不支持清单 |
| WebSocket（`type: "ws"`） | 支持（CC-DOC §Option 4），`url` 为 `wss://` | **缺失（平台限制）且会误挂**：`wss://` 被当 http URL 交给 streamable-http，运行时报错而不是配置期跳过 | `src/mcp.js:59-65`（只看 `entry.url` 是否非空）；实测 `type:'ws'` → `transport: streamable-http`（附录 A-3） | 翻译期识别 `type:'ws'` / `wss:` 前缀 → warn + skip |
| `type` 字段语义与「url 无 type」 | `type` 取 stdio/http/sse/ws/sdk，缺 `type` 的 url 条目被**判定为配置错误并跳过**（CC-DOC §Option 1） | **部分**：完全不看 `type`，只按「有 command 还是 url」推断；url 无 type 时照挂 | `src/mcp.js:50-70`（无任何 `entry.type` 判断，除了 66 行的告警分支） | 按 `type` 分派；对「url 无 type」保留宽松行为但在 README 说明与 CC 的差异 |
| `type: "sdk"` | CC 跳过并报 `Skipped — ... type "sdk"`（CC-DOC §Option 1） | **缺失**：被当 http 挂载 | `src/mcp.js:59-65`；实测 `type:'sdk'` → `transport: streamable-http`（附录 A-3） | `type:'sdk'` → warn + skip，与 CC 对齐 |

## 3. 变量与路径展开

> 这是本审计里**第二大**的系统性缺口：`.mcp.json` 解析对字符串**不做任何展开**（`src/mcp.js:19-73` 全文无替换逻辑），插件侧只有一处 `replaceAll('${CLAUDE_PLUGIN_ROOT}', ...)`（`src/plugins.js:212`）。

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议改法 |
|---|---|---|---|---|
| `${VAR}` | 在 `.mcp.json` 展开（CC-DOC §Environment variable expansion in `.mcp.json`） | **缺失**：env/args/url/headers 全部原样透传 | `src/mcp.js` 无展开；实测 `env:{K:'${K}'}`、`headers:{Authorization:'Bearer ${TOKEN}'}` 原样输出（附录 A-3） | 加 `expandEnv(str, { env: process.env })`，作用于 command/args/env/url/headers，并加单测 |
| `${VAR:-default}` | 同上，未设变量时用默认值；空串算已设 | **缺失** | 同上；实测 `${API_BASE_URL:-https://api.example.com}/mcp` 原样保留 | 同一函数内解析 `:-` 语法；缺变量且无默认时按 CC 行为「warn + 保留字面量」 |
| 凭证类变量在**远程** url/headers 里读为空 | CC 故意把 `ANTHROPIC_AUTH_TOKEN` 等读成空，防止项目 `.mcp.json` 把本机凭证外发（CC-DOC §Credential variables that read as empty） | **缺失（但当前离线「安全」是因为根本不展开）** | — | **实现展开时必须同时实现这条防护**，否则等于新开一个凭证外泄面 |
| `${CLAUDE_PLUGIN_ROOT}` | 插件 stdio 的 command/args/env 与远程的 url/headers 都替换（CC-DOC §Path placeholders） | **部分**：只在「文件文本」路径替换；inline manifest 漏替换（见 §1） | `src/plugins.js:211-216`；实测附录 A-3 | 见 §1 的改法 |
| `${CLAUDE_PROJECT_DIR}` | 插件提供的配置**直接**替换；项目/本地/用户作用域需要 `${CLAUDE_PROJECT_DIR:-.}` 兜底（CC-DOC §Option 3 的说明）；且 CC 在 stdio 子进程**环境变量**里设置它 | **缺失**：既不替换，也不注入子进程 env | `src/plugins.js:212` 只替换 PLUGIN_ROOT；`src/mcp.js:56` env 仅取声明值 | 替换时注入项目根；stdio 分支把 `CLAUDE_PROJECT_DIR` 加进 env |
| `${CLAUDE_PLUGIN_DATA}` | 插件持久化数据目录（CC-DOC §Path placeholders） | **缺失** | 同上 | 需要 DSH 侧有对应目录概念；短期 warn |
| 子进程可见的 `CLAUDE_PLUGIN_ROOT` 环境变量 | 部分插件（如 claude-mem）在运行期读 `process.env.CLAUDE_PLUGIN_ROOT`，而不只是靠 `${}` 替换 | **缺失**：桥接层不注入 | 本机样本 `~/.claude/plugins/cache/thedotmack/claude-mem/13.34.2/.mcp.json` 的命令里显式读 `process.env.CLAUDE_PLUGIN_ROOT`；`src/mcp.js:56` 不含该键 | 插件 MCP 挂载时把 `CLAUDE_PLUGIN_ROOT=<installPath>` 并入 env（claude-mem 当前靠自扫描兜底才没坏） |
| 相对路径解析基准 | stdio 的 `cwd` 语义；headersHelper 的运行目录按作用域区分（CC-DOC §Where the helper runs） | **部分**：`cwd` 原样透传，相对路径由 DSH 进程 cwd 解析（= `~/.dsh/profiles/desktop`，不是项目根） | `src/mcp.js:57`（无 `resolve`）；DSH-CLIENT 字段表 `cwd` = "working directory for the child process" | 以项目根为基准 `resolve(projectRoot, entry.cwd)`，空值时显式传项目根 |

## 4. 字段覆盖

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议改法 |
|---|---|---|---|---|
| `env` | 声明式 + 「用户环境访问：与手写 server 相同的环境变量」（CC-DOC §Plugin-provided MCP servers 的 User environment access） | **部分/平台差异**：只转发声明值；DSH 会 **scrub** 环境变量——名字匹配 `/KEY\|PASSWORD\|SECRET\|TOKEN/i` 与 `DSH_*` 的 ambient 变量被丢弃 | `src/mcp.js:56`；DSH-CLIENT §Environment scrubbing (stdio)：*"ambient names matching `/KEY\|PASSWORD\|SECRET\|TOKEN/i` and ambient `DSH_*` names are dropped"* | 桥接层无法既保持 DSH 的 scrub 又对齐 CC；折中：对 `.mcp.json` 中**未被任何 `${}` 引用**的变量不做处理，README 明确「依赖 shell 里 `*_TOKEN` 的 server 必须在 `env` 里显式写出」 |
| `cwd` | stdio 的工作目录 | **部分**：透传但不解析（见 §3 末行） | `src/mcp.js:57` | 见 §3 |
| `timeout` | 每个 server 可设毫秒超时，覆盖 `MCP_TOOL_TIMEOUT`（CC-DOC §Option 3 的 Note、§Time limits on MCP tool calls） | **缺失**：硬编码 `60_000` | `src/mcp.js:47`；实测 `timeout:600000` → `toolCallTimeoutMs:60000`（附录 A-3） | **最容易修**：`toolCallTimeoutMs: Number(entry.timeout) \|\| 60_000`，并兼容 `MCP_TOOL_TIMEOUT` 环境变量 |
| `alwaysAllow` / `autoApprove` / 权限规则 | CC 现行做法是 `settings.json` 的 `permissions.allow` 写 `mcp__server__tool`（CC-DOC §Plugin MCP tool names 提到在 permission rules 里用全名） | **缺失**：本插件只桥接 hooks（`src/index.js:180-182`），完全不处理 `.claude/settings.json` 的 permissions；且插件 server 命名不同（§6），就算桥接也匹配不上 | `grep -rn "permissions" src/` 无任何结果；本插件对 `settings.json` 的消费仅限 hooks（`src/index.js:21-23`） | 若要覆盖，把 `mcp__*` 形式的 allow 规则翻译成 DSH 权限规则；先修 §6 的命名再谈 |
| `disabled` / `disabledMcpServers` / `enabledMcpjsonServers` / `disabledMcpjsonServers` | `/mcp` 里 toggle，按项目记进 `~/.claude.json` 两个互斥列表（CC-DOC §Disable a server without removing it） | **缺失**：任一形式都不认，server 永远挂载 | `src/mcp.js` 无相关判断；实测 `disabled:true` 的条目仍出现在 `servers` 里（附录 A-3） | `disabled:true` → skip（+debug 日志）；`~/.claude.json` 的 disabled 列表在 §1 读 `~/.claude.json` 时一并消费 |
| OAuth（`oauth` 对象、`claude mcp login`、keychain 存储） | 远程 MCP 的交互式授权，按 endpoint 存凭据（CC-DOC §Authenticate with remote MCP servers） | **缺失（平台限制）**：DSH 只支持静态 `headers` | DSH-CATALOG `StreamableHttpConfig` 只有 `url` + `headers`；`src/mcp.js:64` | 见 §8；短期对提示「需要 OAuth 的 server 请改用静态 token header」 |
| `headersHelper`（动态 header） | 执行 shell 生成 header，按作用域决定运行目录与信任（CC-DOC §Use dynamic headers for custom authentication） | **缺失（平台限制）**：DSH 不起用户命令生成 header | 同上 | 见 §8 |
| `alwaysLoad` / 工具搜索延迟 | `alwaysLoad:true/false` 控制是否进 tool search（CC-DOC §Exempt a server from deferral） | **缺失（平台限制）**：DSH 没有 deferred tool loading，字段被静默丢弃 | `src/mcp.js:34-71` 只读白名单字段；实测 `alwaysLoad:true` 无告警消失（附录 A-3） | 静默丢弃可接受；在 README 不支持清单里注明 |
| 项目 `.mcp.json` 的审批/信任前置 | 交互式会话里先审批才连（CC-DOC §Project scope、§Project server approvals and workspace trust） | **缺失（安全差异）**：无条件挂载任何项目里的 `.mcp.json`，等同把「克隆一个仓库」变成「执行任意命令 + 用你的凭证访问远端」 | `src/mcp.js:96-106`（存在即挂载）；`src/index.js:183-187` | 至少加 `mcpRequireProjectTrust: true` 之类的开关（默认按 DSH 的既有信任模型决定），并在 README 写清这一差异 |

## 5. 生命周期

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议改法 |
|---|---|---|---|---|
| 进程级 vs 会话级 | 会话/项目级：每个项目按自己配置连；`/cd` 会连新目录的插件 server（CC-DOC §Plugin-provided MCP servers → Automatic lifecycle） | **部分/有意偏离**：进程级一次挂载，用启动时 cwd 的**一个**项目 | `src/mcp.js:85-96`；`README.md:144`、`CHANGELOG.md:151` | 见 §8（需架构改动）；短期至少让 root 解析失败可见 |
| 改配置后是否需重启 | 编辑配置条目可热重载；`/mcp` 可 reconnect | **缺失**：`.mcp.json` 只在启动读一次，必须重启 DSH（README 已承认） | `README.md:144`；`src/mcp.js:96-106`（无 watcher/无二次读） | DSH-CLIENT 明说「Editing the configuration entry reloads the server connection in place」——桥接层可在文件 mtime 变化时 dispose 后重挂，属于中等工作量 |
| 插件 enable/disable 时的连接/断开 | 启用即连、禁用即断，`/reload-plugins` 应用（CC-DOC 同上） | **缺失（平台限制）**：插件 MCP 只在 DSH 启动挂一次，`/reload-cc-plugins` 明确不重挂 | `src/index.js:149`（RELOAD_BODY 里写「MCP servers shipped by plugins still require a DSH restart」） | 见 §8 |
| server 启动失败的行为 | 不阻塞启动；`/mcp` 显示 failed；15 分钟内失败过会跳过重连；stream-json 里有 `mcp_server_errors`（CC-DOC §Server status detail、§Failed first connections） | **部分**：默认 `failOnStartupError:false` → DSH 记日志继续；桥接层对 `.mcp.json` 解析失败 warns + skip；但**无状态可见性**（用户无法查「哪个 server 没起来」） | `src/mcp.js:19-24`（注释即设计）、`:102-105`；`src/index.js:95`、`src/index.js:185-187` | 加一条启动后 summary 日志（mounted N / skipped M / warned K），对齐 CC 的 `/mcp` 可见性 |
| 自动重连 | 有（CC-DOC §Automatic reconnection） | **完整（DSH 自带）**：`reconnect.enabled` 默认 true、500ms 起倍增、最多 10 次 | DSH-CLIENT 字段表 `reconnect.*` | 保留；`reconnect` 可考虑透传给高级用户 |
| 连接/发现超时 | CC 有 5s 连接超时、可配 tool timeout | **部分**：DSH 无独立连接/发现超时（继承 SDK 60s），桥接层也不暴露 | DSH-CLIENT §Known Limitations 第 2 条 | 见 §8 |

## 6. 工具命名与冲突

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议改法 |
|---|---|---|---|---|
| 命名形态 `mcp__server__tool` | 同名形 | **完整**：DSH 同样是 `mcp__<serverName>__<rawName>`（DSH-CLIENT §Tool naming and coexistence） | DSH-MCP / DSH-CLIENT；`src/mcp.js:45-49`（取 `serverName` 作命名空间） | — |
| 插件 server 的命名空间 | `mcp__plugin_<plugin-name>_<server-name>__<tool>`，非法字符替换为 `_`（CC-DOC §Plugin MCP tool names） | **缺失**：插件 server 直接用**裸 server key**，没有 `plugin_<plugin>_` 段 | `src/plugins.js:209-231` → `translateMcpServers`；`src/mcp.js:40` 只用 entry 的 key | 插件来源的 server 用 `plugin_<pluginName>_<serverKey>` 作 `serverName`（注意 32 字符上限 → 需哈希压缩）；迁移期可双注册别名 |
| 与 CC 的 permission / hook / `allowed-tools` 兼容 | 上述全名是用户写规则的依据；CC 明确说「用裸 server key 的 matcher 对插件 server 永不触发」 | **缺失（由上一行直接导致）** | CC-DOC §Plugin MCP tool names | 修命名即修此项 |
| `serverName` 合法化 | CC 只替换非法字符 | **部分 + 隐患**：替换非法字符后 `slice(0,32)` **截断**，两个不同 server 可截成同一个名字 | `src/mcp.js:39-44`；实测两个 36 字符名字都变成同一 32 字符名（附录 A-3） | 截断时加 12 位 SHA-256 后缀（与 DSH-CLIENT 对工具名 lossy 归一化的做法一致） |
| 同名 server 冲突 | 三个作用域按名字匹配，高级别整条生效；插件按 endpoint 判重（CC-DOC §Scope hierarchy and precedence） | **部分 + 隐患**：`mounted` 集合是 `mountMcpConfigs` 内部局部变量 → **只对单次调用内去重**；项目与插件、插件与插件之间的同名完全检测不到，DSH 侧表现为「后加载者加载失败」 | `src/mcp.js:110-127`（`const mounted = new Set()` 在函数内）；调用点 `src/mcp.js:106`、`src/index.js:208`（每个插件一次） | 把 `mounted` 提到模块级（或作参数传入），并在冲突时按 §7 优先级选择而非按到达顺序 |
| 同一 server 的 tool 列表重复 | CC 侧不适用 | **完整（DSH 兜底）**：重复 tool 的列表会被判非法并保留上一代工具集 | DSH-CLIENT §Tool naming and coexistence | — |

> 附注：DSH 对工具名还有一层「lossy 归一化 + 12 位哈希」的公共名契约（DSH-CLIENT §Design philosophy），所以长/怪名字不会崩，但**模型的工具名会和 CC 里配置的规则文本不一致**——这正是上表第三行的影响面。

## 7. 作用域优先级 / 合并

| 能力项 | Claude Code 行为 | 本项目现状 | 证据 | 建议改法 |
|---|---|---|---|---|
| 优先级链 | Local > Project > User > Plugin > claude.ai connector；`managedMcpServers` 最高（CC-DOC §Scope hierarchy and precedence） | **缺失**：没有任何合并层。项目 `.mcp.json` 与插件 MCP 是两个独立的 fire-and-forget 调用 | `src/index.js:183-193`（`mountMcpServers(...)` 与 `mountPluginMcp(...)` 都不 await） | 先收集所有来源到一张按优先级排序的表，再单次 `mountMcpConfigs` |
| 同名字段是否跨作用域合并 | **不合并**，取最高优先级来源的整条 entry | **不适用（无合并）**，当前行为是「两条都注册」→ DSH 报错 | 同上 | 实现合并时保持「整条替换」语义，别做字段级 merge |
| 插件按 endpoint 判重 | 与高层级 server 指向同一 URL/command 时算重复（CC-DOC 同上） | **缺失** | `src/mcp.js:75-83` 只处理 env 字典，无 URL 归一化比较 | 可选；按 scheme/host 大小写、默认端口、末尾斜杠归一化后比较 |
| 挂载顺序的确定性 | 由优先级决定 | **不确定**：两个 async 调用同时起跑，谁先 `ctx.plugin()` 取决于 await 时序 | `src/index.js:183-193` | 串行 `await` 并按优先级排序 |

---

## 8. 无法支持 / 平台限制

以下不是「改桥接代码就能补齐」的，而是 DSH 平台当前没有对应能力（或与 DSH 的既有安全模型冲突）。README 应有一节明确写出，避免用户以为是 bug。

1. **旧 SSE 传输**。`dsh-mcp-client` 的 `transport` 联合类型只有 `stdio | streamable-http`（DSH-CATALOG），没有 SSE。CC 已弃用 SSE，但仍有服务只提供 `/sse`。桥接层能做的上限是「配置期明确告警」，不能真的连上。
2. **WebSocket 传输**。同上，DSH 无 `ws` transport。当前实现会把 `wss://` 当 http 挂载，属于「错误的成功」——应改为跳过 + 告警。
3. **远程 MCP 的 OAuth**。CC 有完整交互式授权（`/mcp`、`claude mcp login`、预置 client 凭据、scope 限制、按 endpoint 存 token）。DSH 的 HTTP 配置面只有静态 `url` + `headers`，没有凭据存储与授权码流程。**要获得同等体验需要 DSH 侧新增能力**；桥接层只能提示用户改用静态 token。
4. **`headersHelper` 动态 header**。需要在用户 shell 里执行命令并注入结果，DSH 侧没有该机制，也不宜由第三方插件擅自执行项目里的脚本（这正是 CC 自己都要加 trust dialog 的原因）。
5. **MCP prompts / elicitation / tasks / resource subscriptions**。DSH-MCP §Limits 明确不支持：*"MCP prompt templates, human-input elicitation, task-based execution, and resource subscriptions are unsupported."* 因此 CC 的「MCP prompts as commands」、`tasks/*` 类长任务、`elicitation/create` 都无法桥接。资源读取本身是支持的（DSH 自带 `mcp-resources`）。
6. **`alwaysLoad` / expanded tool search**。DSH 没有 deferred tool loading，MCP 工具永远全量进工具表。字段被忽略不会坏事，但「省 context」的意图无法实现。
7. **子进程环境变量的继承策略**。DSH 主动 scrub ambient `*TOKEN|*KEY|*PASSWORD|*SECRET` 与 `DSH_*`（DSH-CLIENT §Environment scrubbing），CC 则给插件 server「与手写 server 相同的用户环境」。桥接层若要把 `process.env` 整份塞进 `env` 来对齐 CC，等于绕开 DSH 的环境消毒策略——**不建议**；正确做法是让用户在 `.mcp.json` 的 `env` 里显式声明，并在 README 写明这个差异。
8. **按会话/按项目切换 server 集合**。DSH 的 mcp-client 是 Cordis scope 插件，理论上可在每个 Agent scope 复用同名 server（DSH-MCP §Responsibilities and scope）。但本插件在**插件激活作用域**（进程级）挂载一次，要改成会话级需要：
   - 在 session/agent scope 内调用 `ctx.plugin(mcpClient, ...)`（生命周期与 session 绑定）；
   - 处理 cwd 变化、项目切换、以及 `.mcp.json` 变更时的 dispose + 重挂。
   这是架构改动，不是文件翻译层能完成的，且与 README 现有「process-lifetime by design」的承诺冲突，需要一次破坏性变更来切换。
9. **权限规则桥接**。CC 把 `mcp__*` 允许规则写在 `.claude/settings.json` 的 `permissions.allow`。本插件的能力面只覆盖 skills/commands/rules/agents/hooks/MCP 翻译，不读 permissions（`grep -rn "permissions" src/` 无结果）。补齐属于跨能力面改动，且需先修 §6 的插件命名。

---

## 附录 A：实测证据（仓库源码 + /tmp fixture，未改动仓库任何文件）

**A-1 项目根解析在 DSH 桌面进程 cwd 下失败**

```
cwd         = /Users/chengable/.dsh/profiles/desktop      # 实测 ps/lsof: pid 52602 (desktop-host runtime) cwd
markers     = .git,CLAUDE.md
projectRoot = undefined  → mountMcpServers() 在 mcp.js:94 直接 return，无任何警告
```

**A-2 本机 `~/.claude.json`**

```
top-level mcpServers: NoneType None
95 个 project 记录，每个都带 mcpServers 键；非空数量：0/95
```

说明结构真实存在（这是 `claude mcp add` 的默认写入位置），只是这台机器上恰好为空——本项目读不读它，与本机是否为空无关。

**A-3 翻译行为（节选，全部为实际输出）**

| 输入（`translatePluginMcp` / `translateMcpServers`） | 实际输出 | 期望（对齐 CC） |
|---|---|---|
| 插件 inline `{command:"${CLAUDE_PLUGIN_ROOT}/servers/db-server"}` | 命令原样保留 `${CLAUDE_PLUGIN_ROOT}/...` | 替换为 `<installPath>/...` |
| 插件 path-string `./mcp.json`，command 含 `${CLAUDE_PLUGIN_ROOT}` | 正确替换 | 一致 ✅ |
| 插件 path-string，env `R: "${CLAUDE_PROJECT_DIR}/p"` | 原样保留 | 替换 |
| `.mcp.json` `type:'sse'` + url | `transport: streamable-http`，无警告 | 警告（DSH 无 SSE） |
| `.mcp.json` `type:'ws'` + `wss://` | `transport: streamable-http`（错误） | 跳过 + 警告 |
| `.mcp.json` `type:'sdk'` + url | `transport: streamable-http` | 跳过（CC 跳过） |
| `.mcp.json` url 无 `type` | 照挂 | CC 判配置错误并跳过 |
| `env:{K:"${K}"}` / `headers:{Authorization:"Bearer ${TOKEN}"}` | 原样字面量 | 展开 |
| `timeout: 600000` | `toolCallTimeoutMs: 60000` | 600000 |
| `disabled: true` | 仍然挂载 | 跳过 |
| `alwaysLoad: true` | 静默丢弃 | 平台不支持，可接受 |
| 两个 36 字符 server 名（前缀 32 个 `a`） | 都变成同一个 32 字符 `serverName` | 应可区分（加哈希） |

**A-4 去重集合的作用域**

`mountMcpConfigs()` 每次调用新建 `mounted` 集合（`src/mcp.js:120`），而调用点是「项目一次、每个插件各一次」（`src/mcp.js:106`、`src/index.js:208`），且两者都是不 await 的并发调用（`src/index.js:183-193`）。因此同名 server 在 DSH 侧会真实出现两次注册，DSH 的语义是「后加载者加载失败并报错」（DSH-CLIENT §Tool naming and coexistence）。

**A-5 部署副本一致性**

```
desktop: v1.0.3  src/mcp.js md5 = b827fcf3d178f1eb7bda44dbde7f10c6  (= 仓库)
web:     v1.0.3  src/mcp.js md5 = b827fcf3d178f1eb7bda44dbde7f10c6  (= 仓库)
```

---

## 附录 B：建议的修复顺序（按「影响 ÷ 成本」）

| 序 | 改动 | 成本 | 收益 |
|---|---|---|---|
| 1 | `timeout` → `toolCallTimeoutMs`；插件 inline 分支补 `${CLAUDE_PLUGIN_ROOT}` | 各 1 行 | 立刻消除两处「文档承诺 vs 实际行为」的不一致 |
| 2 | 翻译期按 `type` 分派；`sse`/`ws`/`sdk`/url-无-type 明确 skip + warn | ~30 行 | 消除「静默误挂 → 运行时报错」 |
| 3 | `${VAR}` / `${VAR:-default}` 展开 + 凭证变量置空防护 | ~40 行 + 单测 | 让真实 `.mcp.json` 可用（含 auth） |
| 4 | 项目根解析失败可见化；改用会话 cwd（或至少 fallback 到会话 cwd 的只读模式） | 中等 | 修掉 ★★★ 第 1 项 |
| 5 | `mounted` 集合提到模块级 + 单次批量挂载 + 优先级排序 | ~50 行 | 修掉竞态与同名冲突 |
| 6 | 读 `~/.claude.json`（顶层 + `projects[path]`）并按优先级合并 | ~80 行 | 修掉 ★★★ 第 3 项 |
| 7 | 插件 server 命名空间 `plugin_<plugin>_<server>` + 截断哈希 | ~40 行（破坏性） | 对齐 CC 的规则/钩子/白名单文本 |
| 8 | README 增加「不支持清单」（本文件 §8） | 文档 | 把平台限制从「疑似 bug」变成「已知约束」 |
