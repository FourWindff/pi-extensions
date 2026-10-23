# pi 三模式扩展（build / plan / ask）

三种工作状态，一个手势单向循环：**build → plan → ask → build**（shift+tab）。当前模式显示在输入框底边框**左侧**，开头与上边框工作状态统一使用 `── ` 前缀，模式名与工作状态块（包含 spinner）起点对齐，紧跟其后是当前位置（`~/路径 (分支)`），颜色跟随主题：build 蓝、plan 黄、ask 绿。为此 pi 自带 footer 的 pwd 行被接管拿掉（见下方「已知边界」）。

- **build**：今天的 pi。工具集不动，零回归；提问表单本来就在全量注册工具里。
- **plan**：只读研究 + 只能写 `.pi/plans/<slug>.md` + 只能派只读子 agent `explore` + 能用一个提问表单把待确认的问题一次交给用户。**bash 不设限**（用户明确要求：不再做任何字符判定，`rm`、`git commit`、`npm install` 都放行）。write/edit 与子 agent 两条仍由工具层强制，不靠模型自觉。
- **ask**：只回答问题（也能反问）+ 工具表里没有 `write`/`edit`/MCP，bash 只剩只读命令，子 agent 只放 `explore`。

模式只能由用户切换：扩展不注册切模式工具，也不监听任何事件去自动切换。新会话从 build 开始，resume 保留当时的模式（模式与「进模式前的工具集快照」一起写进会话记录；快照带 `toolsSettled` 标记，**没有这个标记的旧记录拒绝恢复**，直接回 build 默认工具集——那批旧记录里就有启动 5 秒内抓的半初始化快照）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 接线：快捷键、工具集切换、提示词 section、`tool_call` 守卫、输入框底边框标签（模式 + 当前位置）、footer 接管、会话状态 |
| `policy.ts` | 全部判定规则（纯函数，不 import pi / 不碰 fs / 不碰终端） |
| `plan.md`、`ask.md` | 模式文件：YAML 头（`name`、`tools`）+ 提示词正文 |
| `policy.test.ts` | 行为测试：`node --test` |

提问表单（`ask_user`）在**同级目录的 `ask-user/` 扩展**里，与模式无关（三个模式都能用），见 `../ask-user/README.md`。本扩展与它的全部关系是：`plan.md`、`ask.md` 的 `tools` 白名单里写着 `ask_user` 这个名字。

## 一次性配置：把 shift+tab 让出来

shift+tab 在 pi 里默认绑给 `app.thinking.cycle`，并且属于**扩展不可覆盖的保留键**——不改配置时扩展注册会被静默跳过（只有启动日志里一条 warning，功能没有入口，其余部分照常）。已在本机 `~/.pi/agent/keybindings.json` 里改好：

```json
{ "app.thinking.cycle": "alt+t" }
```

扩展本身不会修改这个文件。改完 `/reload` 或重启，`/hotkeys` 里能看到 `Shift+Tab — Cycle agent mode (build → plan → ask)`，thinking 用 `alt+t` 切。

## 模式文件

想改措辞直接改 `plan.md` / `ask.md` 的正文；`tools` 决定该模式的工具白名单，`name` 缺失即视为无效文件（此时**不切换**，并提示原因）：

```markdown
---
name: plan
tools: read, grep, find, ls, bash, write, edit, web_search, fetch_content, get_search_content, source_check, subagent, ask_user
---
（正文提示词，注入为系统提示词的 mode section）
```

- 工具名可以写当前环境不存在的（pi 会静默忽略），白名单是**完整清单**：以后新装的工具不会自动出现，要手动加名字。
- MCP（`mcp`、`mcpScript`）故意不进任何模式：它是万能后门。
- `ask_user` 三个模式都有，但那是 `ask-user/` 扩展的事：本扩展只靠在 `plan.md`、`ask.md` 的 `tools` 里写上这个名字把它留在白名单里（build 本来就是全量注册工具）。想拿掉就删自己那份白名单里的名字（build 用 `/tools`）。
- 模式文件与扩展同目录，**不放** `~/.pi/agent/agents/`：那个目录会被 subagent 扩展全量扫描并变成可派遣的子 agent。pi 对扩展子目录只加载 `index.ts`。
- 模式文件没有热重载，改完 `/reload` 或重启。

## 提问表单（ask_user）

由同级 `ask-user/` 扩展提供，与模式无关：三个模式都能用（build 全量工具、plan/ask 靠白名单），只有非 TUI 会话看不到。交互、参数、边界都在 `../ask-user/README.md`；这里只记住一句：**切换模式不会动它**，除非你把白名单里的名字删掉。

## 只读守卫

`tool_call` 里拦下，并把理由回给模型：

- **bash**（只剩 ask 在守）：
  - **plan**：全部放行，不经过任何判定。
  - **ask**：只读白名单。`cat`、`sed -n`、`jq`、`git status|log|diff|show|branch|remote|config --get`、`git ls-*` 等开头才放行；`rm`、`git push`、重定向 `>`、管道到 `tee`、`npm install`、`mkdir`、`curl -o`、`find -delete`、`sort -o` 以及复合命令（`cd x && git log`）一律拦下。
- **write / edit**（plan）：目标路径必须解析到 `<cwd>/.pi/plans/` 下且是 `.md`。
- **write / edit**（ask）：全拦（防「切模式瞬间已有一次调用在飞」的漏网）。

## 已知边界与漏洞（都写在这里，不在代码注释里藏）

- **子 agent 的只读性分两层，各有一处漏**：父进程按 agent 名守（`ALLOWED_SUBAGENTS`：plan 与 ask 只放 `explore`，build 不设限），子进程按 `explore.md` 的 `tools: read, grep, find, ls` 守（**没有 bash**，所以它跑不了测试与 `git log`，这些留给父进程）。漏点：名字判定只认名字——`<cwd>/.pi/agents/` 里若有一个自报 `name: explore` 但带写工具的 agent，会通过这道检查；`agentScope: "project"` 才会走到它，默认 `"user"` 不会。ask 的工具表里也有 `subagent`（同样只放 `explore`），所以这条对两个只读模式都是实打实的守卫。
- **`setActiveTools` 是「整份名单一次生效」，没有部分成功**：名单里只要有一个当时未注册的名字（MCP 动态工具、被扩展注销的工具），整次调用就是空操作——曾出现「标签写着 build、工具集还是上一模式的只读集合」。现在 `setToolsFor` 会回读 `getActiveTools()`：发现「已注册却没生效」就剔掉陌生名字重发一次，仍缺则在通知里点名（恢复会话时同样会报）。build 快照也不再在切模式的那一刻现取：在 build 里每开一轮都刷新（启动 5 秒内那份半初始化快照就是这么进来的）；没有经过任何一轮就离开 build 时退回「全注册工具」，因为那时「用户故意关掉某个工具」无从谈起。
- **plan 的 bash 没有沙箱，也不再有启发式**：那里完全靠模型自觉 + `plan.md` 的提示词。这是明确取舍，不是漏；要真隔离得上沙箱（`bwrap`/容器）。ask 的白名单仍只是启发式：未列入白名单的写法按「不在白名单」拦下，但一个看起来只读的聪明命令仍可能钻过去。
- **不做符号链接解析**：`.pi/plans/` 里一个指向源码的软链可以绕过路径守卫。
- **输入框底边框整行被模式标签接管**：长输入时 `↓ N` 滚动提示被覆盖，这是刻意取舍（标签优先）。标签不够宽时先截断位置、再退成纯边框，模式名最后才会消失。
- **接管了 pi 自带 footer**：位置信息搬到输入框底边框后，footer 第一行（pwd + 分支 + session 名）会重复，所以本扩展用 pi 导出的 `FooterComponent` 渲染同一份统计、只丢掉 pwd 那一行（stats、缓存率、cost、context%、`(auto)`、扩展状态行都在）。代价：依赖 pi 的 footer 内部行序（`render().slice(1)`）和 `AgentSession` 形状（`ctx` 拼一个替身对象补齐），以及**虚拟模型的路由箭头 `→ 模型` 会消失**（`routedModel` 没有 ctx 等价物）。pi 升级后若行序变了，改 `index.ts` 里的 `installFooter` / `footerSession`；真的抛错时 footer 会显示一行 `footer unavailable`，不会拖垮整个 TUI。
- **非 TUI 场景**（RPC / `--mode json` / print）整个功能不启用：不恢复会话里的模式、工具集保持默认、守卫也不生效——那边没有切换入口，恢复一个出不去的只读状态只会添乱。（提问表单在那边同样用不了，但那是 `ask-user/` 扩展自己摘的。）
- **`ask_user` 需要 TUI，但那不归本扩展管**：注册与摘除（非 TUI 会话）都在 `ask-user/` 扩展里，模式这边只在白名单里见得到这个名字。
- 已知代价：切模式会让 provider 重读会话前缀（补丁消息记在切换处）。**空切**（没发消息就切回去）不产生请求、零成本。

## 测试

```bash
cd ~/.pi/agent/extensions/mode-switching
node --test
```

断言的都是外部行为：循环、模式文件解析、bash 判定、计划路径守卫、工具集计算（含「还原保持原顺序」，顺序错了会让 provider 前缀缓存失效），以及两份模式文件的白名单里确实写着 `ask_user`。提问表单自己的测试在 `../ask-user`。

## 手工验证清单

1. 启动 pi，输入框底边框左侧出现 `build`（蓝），紧跟 `~/Code/MindLane (main)`；上下边框开头都为 `── `，模式名与上方工作状态块（包含 spinner）起点对齐；footer 只剩统计行（pwd 行没了）。
2. shift+tab → 变 `plan`（黄），并有一条提示；`alt+t` 仍能切 thinking。
3. plan 里让模型改 `src/` 下的文件 → 被拦，理由里带「切到 build」。
4. plan 里让它写 `.pi/plans/demo.md` → 放行，文件出现。
5. plan 里跑 `git push` / `rm` / `npm install` → 全部放行（bash 无守卫）；ask 里同样的命令 → 被拦。
6. 再按一下 → `ask`（绿）。
7. 切回 build → 标签回 `build`，`/tools` 与最初一致（含顺序）。
8. resume 同一会话 → 模式保留；新会话 → `build`。
9. 触发一次 subagent picker → 上下键照常可用（编辑器包装是透传的）。
10. 提问表单（`ask_user`）→ 见 `../ask-user/README.md` 的手工清单；本扩展只需要确认：plan / ask 切过去以后 `/tools` 里还有它。
11. 三个模式的 `/tools` 里都能看到 `ask_user`；切回 build 后工具集与最初一致（含顺序）。
