# CLAUDE.md — 本仓库开发经验

> 这里只记**做过一遍才知道的事**：改动怎么生效、哪里会丢配置、什么时候必须重启、出事怎么回滚。
> 项目是什么、对外怎么用 → 看 [README.md](README.md)；DSH 平台侧实测事实（事件名、skill 工具 schema、会话日志格式）→ 看 [docs/HANDOFF.md](docs/HANDOFF.md)，不用重新调研。

---

## 1. 第一原则：仓库里的源码 ≠ DSH 正在跑的代码

DSH 启动时从 **profile 目录** import 插件：

```
~/.dsh/profiles/<profile>/node_modules/dsh-claude-compat
```

仓库里的 `src/` 只是源码。**改仓库文件、不部署、不重启 → DSH 里什么都不会变**，而且不会有任何报错，最容易被误判成"改了没效果"。

判断当前跑的到底是哪份：

```bash
# 部署副本的版本号
python3 -c "import json;print(json.load(open('$HOME/.dsh/profiles/desktop/node_modules/dsh-claude-compat/package.json'))['version'])"
# 进程启动时间（早于文件 mtime = 还在跑旧代码）
ps -o pid,lstart,command -p <dsh 进程 pid>
# 关键默认值是否已经落进副本
grep -n "enablePluginMcp: z.boolean().default" ~/.dsh/profiles/desktop/node_modules/dsh-claude-compat/src/index.js
```

**配置也按会话 workspace 解析**：hooks 与 MCP 的项目级配置（`.claude/settings.json`、`.claude/settings.local.json`、`.mcp.json`）现在都从会话工作目录解析。历史上的坑是按 `process.cwd()` 解析 —— 桌面宿主 cwd 是 `~/.dsh/profiles/desktop`，于是项目级配置永远读不到、且没有一行日志。以后新增任何"项目级"读取，都用会话 cwd，不要用进程 cwd。

profile 的 `package.json` 里依赖写的是 `github:chengable/dsh-claude-compat#main`，`dsh.profile.bundles` 里也有它 —— 也就是说"装一次"记的是 github 解析结果，而 deploy-local 是**纯文件覆盖**，两者会各自留下痕迹（见 §9）。

---

## 2. 改完代码的标准闭环

```bash
# 1) 先测，全绿再往下走
npm run check

# 2) 提交（代码 + 测试 + 版本号 + 中英 CHANGELOG 一起提）
git add -A && git commit

# 3) 同步到 profile：默认 desktop；先 --dry-run 看会改什么
bash scripts/deploy-local.sh --dry-run
bash scripts/deploy-local.sh
bash scripts/deploy-local.sh --profile web     # 另一个端要单独来一次

# 4) 重启对应端（见 §4），然后按 §1 的命令验证
```

`deploy-local.sh` 会做四件事，也因此值得用而不是手 copy：

1. 先备份到 `~/.dsh/backups/dsh-claude-compat-<时间戳>/`（出事能回滚，见 §6）
2. 镜像 `src/`、`scripts/`（`rsync --delete`）+ 覆盖 `package.json`、`cordis.patch.yml`、中英 README/CHANGELOG
3. 逐文件 `diff`/`cmp` 校验，不是只信 rsync 的退出码
4. 对每个 `.js`/`.mjs` 跑 `node --check` —— 语法错会在下次启动时把整个插件带下去，症状离脚本很远

它只覆盖**已经装过**的 profile；没装过的会直接报错并提示先 `plugin add`。

**push 是必需的么？** 生效不需要（同步是本地目录 → 本地目录）；但这两种情况必须先 push：
profile 依赖指向 `github:...#main`，用 `plugin add` 走正规 pnpm 升级时要从 github 取；发版与市场索引也一样。所以默认按"提交 + push"收尾。

---

## 3. profile 是隔离的：装一次 ≠ 两端都有

| profile | 谁在用 | 装插件的方式 |
|---|---|---|
| `desktop` | 桌面 app（Electron，当前 Web GUI 在 60228，app 自己分配、重启可能变） | **app 自带 CLI** 或 app 内插件市场 |
| `web` | `dsh web`（CLI，默认 3080） | 全局 `dsh` 或 app 自带 CLI |
| `headless` / `acp` | CLI 子命令 | 同上 |

- 每个 profile 有**独立**的 `node_modules` 和 `cordis.patch.yml`；装插件、deploy、改配置都是**每个 profile 各来一次**。只更新了 desktop，web 端看起来"没修好"是正常的，不是 bug。
- **共享**的是 `$DSH_HOME` 下的凭证、`sessions/`、`storages/` —— 会话历史两边能看到，插件状态看不到。
- 桌面版 profile 由 Electron 独占：`~/.npm-global/bin/dsh`（全局 npm CLI，0.2.1-rc.5）会直接报
  `profile "desktop" is managed exclusively by the Electron application`。
  要用 **app 自带 CLI**：

  ```bash
  CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  "$CLI" plugin --profile desktop list      # 实测可用
  "$CLI" plugin --profile desktop add github:chengable/dsh-claude-compat#main
  ```

---

## 4. 什么时候要重启，什么时候不用

| 改了什么 | 要重启吗 | 原因 |
|---|---|---|
| pnpm 增删/更新插件（`plugin add`、市场 UI） | 不用 | DSH 的 HMR 会 watch profile 目录（`package.json` + `node_modules` 结构），活进程能热挂载新的 loader entry（实测：进程 12:00 启动、插件 12:09 装进去，直接生效） |
| 插件源码内容（deploy-local 覆盖 `.js`） | **要** | `.js` 文件内容变化不在 HMR watch 范围 |
| profile 的 `cordis.patch.yml` | **要** | 配置在插件激活时读取，不热生效 |
| 技能文件（`.claude/skills/**`） | 不用重启进程 | 但 catalog 在**会话创建时快照** → 新会话，或 `/reload-skills`（它会清缓存并广播，当前会话即可拿到） |

重启方式：

- 桌面版：退出 app 再打开（Electron 主进程整体重启）
- `dsh web`：`bash scripts/dsh-restart.sh`（默认 3080；先停旧进程，再 nohup 启动并 curl 健康检查）——只重启 `dsh web`，**不会**动桌面 app

---

## 5. "想要的行为"要落在 schema 默认值里，不要放 profile patch

`cordis.patch.yml` 里的 patch 行会被这些动作带走：

- 插件重装（卸载/安装都会碰 patch 层）
- app 启动失败后的恢复流程（`sanitizeProfile()` 会把 patch 改名备份、把 bundles 重置回模板）

本仓库的教训：`enablePluginMcp` 原本默认 `false`，于是想挂插件声明的 MCP server 就得在 profile patch 里手写 6 行，每次重装都要补一遍、忘了就静默回到"不挂 MCP"。正确解法是**把默认值改对**（v1.0.3），让安装本身恢复出期望行为。

- 反过来不要做：让插件在激活时去写 host 的配置（越权、更脆弱）
- 改默认值必须同步四处：`src/index.js`、README 中英配置表、CHANGELOG 中英、以及一条**钉住默认值的 test**（参考 `test/v103.test.js`）

---

## 6. 出事了怎么回滚

- 插件是**一个 provider**，加载失败时它贡献的**整批技能/命令/agent 一起消失**（不是某一个技能不见）。看到 `.claude` 来源的技能全没了，先怀疑插件加载，别去查单个 skill 文件。
- app 起不来时会弹「禁用插件以恢复」——**别点**。它会重命名 patch、把 bundles 重置回模板，插件从 bundle 列表里消失，事后要手工修回来。宁可手动恢复备份文件。
- 回滚手段（从轻到重）：

```bash
# a) 恢复 patch 层
cp ~/.dsh/profiles/desktop/cordis.patch.yml.bak-<时间戳> ~/.dsh/profiles/desktop/cordis.patch.yml

# b) 恢复插件副本（deploy-local 每次都会建备份）
ls ~/.dsh/backups/ | grep dsh-claude-compat | tail -1

# c) 代码层面回退，然后重新部署
git revert <坏提交> && bash scripts/deploy-local.sh
```

任何回滚之后都要**重启**才生效（§4）。

---

## 6.5 跨轮次的状态要考虑重启语义

插件里凡是「这一轮攒着、下一轮再用」的内存状态，都要问一句：**中间重启了怎么办？**

真实教训（v1.1.3）：Stop hook 的提示先缓冲、等下一次 prompt 才投递。结果连着两次
「重启 → 发一句话」都看不到提示 —— 因为队列只活在进程内存里，而重启后的第一次
Stop 还没发生，队列必然是空的。改成在轮次结束时**当场追加**到会话 surface
（`session.append('user/message', msg, { surfaceOp: 'append' })`，与 DSH 投递
runtime context 用的是同一个 API），缓冲只作为兜底。

判断标准：这个状态如果只影响"下一次交互"，就该持久化（session/storage）或改成即时动作；
不要依赖进程内存跨越用户可见的时间边界。

另外：验证"改动是否生效"时，先看进程启动时间 vs 部署时间 —— 这类问题十有八九是
进程还跑着旧代码，而不是逻辑错了（本次连续三次都是这个原因）。

## 7. 测试规矩

- `npm run check` 是门槛（`node --check` + `node --test`）；改 `src` 之前先跑一遍确认基线。
- **测试必须自包含**：不许读真实的 `~/.claude`、真实的插件安装、真实的 `~/.dsh`。用 tmp 目录造 fixture —— 插件市场那种结构是
  `<root>/installed_plugins.json` + `<root>/cache/<marketplace>/<name>/<version>`。
  （v1.0.4 修的就是这条：两个用例写死本机 omc 插件，导致换台机器必红。）
- 不要长期留红：环境依赖的用例要么 fixture 化、要么显式 `skip` 并写清原因。"65/67 通过"这种状态会一直拖住后面每一次判断。
- 新增/删除内置管理 skill → 同步 `test/self-check.test.js` 里**两处**硬编码的 skill 名单（约 105、128 行）。
- 改默认值、改签名、修 bug → 加一条针对性 test 钉住（`test/v102.test.js`、`v103.test.js` 是范例）。

---

## 8. 提交、版本与发布

一次完整改动 = 代码 + 测试 + `package.json` 版本 + `CHANGELOG.md` **和** `CHANGELOG.zh-CN.md`（涉及配置面时再加 README 中英表格）。

- 提交信息用中文，`type(scope): 标题`；正文按「问题 → 改法 → 验证」写。破坏性变更用 `feat!:` 并在正文写 `BREAKING CHANGE:`（参考 `349929f`）。
- 版本号和 CHANGELOG 一起提。纯测试/文档改动走 patch 版本也可以（1.0.4 就是这么来的）。
- 发版三步：

```bash
npm publish                                   # 1) 发布
node scripts/update-market-index.mjs          # 2) 重新生成市场索引 site/index.json
git add site/index.json && git commit         # 3) 提交，market.yml 会部署到 GitHub Pages
```

---

## 9. 排查速查

```bash
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

"$CLI" plugin --profile desktop list          # 装了哪些插件（桌面版只能用它）
ps -o pid,lstart,command -p <pid>             # 进程启动时间，判断是否已重启
ls ~/.dsh/backups/ | tail -5                  # deploy-local 的备份
```

- `deploy-local.sh` 是文件覆盖，**不更新 pnpm 锁**：插件管理界面可能显示旧版本号（曾出现实际 1.0.2、界面 0.9.1）。功能不受影响，但状态不一致；要干净状态就用 `"$CLI" plugin --profile desktop add github:chengable/dsh-claude-compat#main` 走一次正规 pnpm。
- 端口：桌面 app 的 Web GUI 当前 `60228`；`dsh web` 默认 `3080`。排查"改了没生效"前先确认你连的是哪个进程、哪个 profile。
- 环境：macOS 没有 `timeout` 命令（别在脚本里用）；解析 DSH 会话日志需要 `zstd`（`brew install zstd`）。

---

## 10. 历史记录去哪找（这个项目比较特殊）

- 本项目相当一部分早期工作是在 **`../video-agent` 工作区**做的（cwd 在那边，仓库在别处），那个工作区没挂 claude-mem hook，所以 `/mem-search` 搜不到本项目。
- 要用 DSH 自己的会话归档：

```bash
ls ~/.dsh/sessions/          # 目录名是 munged 的 cwd
zstd -dc ~/.dsh/sessions/<munged>/session-<id>/session.v4.jsonl.zstd > /tmp/s.jsonl
```

  解析要点：
  - 一行一个 JSON 事件；`type=tool/call` 的 `data.arguments` 是**字符串**，要再 `json.loads` 一次才能拿到 `command`
  - 用户诉求在 `type=agent/inbox/spliced` 的 `data.inserted[].content[].text`
  - 高效套路：先抽 user prompts 看需求演进，再按关键词 grep（`deploy-local`、`cordis.patch`、`重启`…）

---

## 11. 已知遗留（知道就行，别每次重新发现）

- 内置的 `install-dsh-compat` skill 里写的仍是上游 `biedongbin/dsh-claude-compat` 地址；本 fork 安装应使用 `github:chengable/dsh-claude-compat#main`。
- `package-lock.json` 的 `version` 停在 `1.0.0`（历次 bump 都没同步它），不代表发布状态。
- npm 上仍是上游的 `1.0.0`，fork 的 `1.0.1`~`1.1.0` 未发布；市场索引由 npm registry 生成，所以 `site/index.json` 里的 author/homepage 还是上游 —— 不是 bug。
- [`docs/HANDOFF.md`](docs/HANDOFF.md) 是一次任务的交接文档，部分待办已过期；读之前先对一遍 `git log`。
