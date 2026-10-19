# Skill Rider

给任意 skill 追加一段额外提示词，**不改动 skill 自身的文件**。

- 额外提示词存在 `~/.pi/agent/skill-riders.json`，按 skill 名索引。
- `/skill:<名字>` 触发时，追加的提示词作为**独立块**排在紫色 skill 块之后（用户输入的命令参数排在最后）。
- 模型自己读取 `SKILL.md` 时，提示词追加在该次读取结果末尾。

## 用法

```
/skill-rider
```

弹出居中窗口：左右**两个独立方框**，外面再包一圈公共外框。

- 左框：搜索框 + skill 列表，**始终有一行带 `▸` 高亮**，标题栏显示 `匹配数/总数`。
- 右框：上半部以灰色只读显示该 skill 的 `SKILL.md` 原文（可用 `PgUp`/`PgDn` 翻页，标题栏显示 `首-末/总` 行号；内容超长时才显示行号与翻页提示），下半部是额外提示词编辑区。
- 编辑区没有边框，靠中间那条 `─── ✎ Extra prompt · Tab to edit ───` 分隔线指示输入位置；进入编辑后分隔线变强调色并显示 `· editing`，同时出现光标。

| 键 | 作用 |
|---|---|
| 直接输入 | 过滤左侧列表（左侧聚焦时输入永远进搜索框） |
| ↑ / ↓ | 移动高亮，右侧**立即**显示内容（不用回车） |
| PgUp / PgDn | 上下翻看原 skill 原文（编辑时这两个键归编辑器） |
| Tab / Enter | 编辑高亮 skill 的额外提示词 |
| Shift+Enter | 编辑时换行 |
| Esc | 保存并关闭窗口（在编辑中则先结束编辑） |

列表里有 `●` 的表示该 skill 已有提示词。清空内容即删除该 skill 的提示词，空条目不会写进文件。

## 文件

| 路径 | 说明 |
|---|---|
| `~/.pi/agent/extensions/skill-rider/index.ts` | 扩展入口：命令、注入逻辑、读写存储 |
| `~/.pi/agent/extensions/skill-rider/panel.ts` | 左右分栏的 TUI 窗口 |
| `~/.pi/agent/extensions/skill-rider/riders.ts` | 纯逻辑：存储读写、skill 块拼装 |
| `~/.pi/agent/extensions/skill-rider/riders.test.ts` | 冒烟测试：`node --test riders.test.ts` |

改动 skill 列表（新增/删除 skill）后执行 `/reload`；提示词是每次触发时现读的，改完立即生效。

## 已有提示词

| skill | 来源 |
|---|---|
| `ponytail-audit` | 由旧的 `audit-docs` 扩展迁移而来（该扩展已停用，见 `~/.pi/agent/extensions-disabled/audit-docs/`） |
