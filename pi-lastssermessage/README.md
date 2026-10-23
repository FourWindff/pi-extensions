# pi-lastssermessage

在输入框第一条边框的右侧显示最近一条已进入会话的用户消息，不增加行数，不修改聊天记录。

- 预览固定占 **40 个终端显示列**，短消息靠右对齐，左侧空位用边框横线填满，只在消息前留一个空格，长消息以 `…` 截断；中文、emoji 按显示宽度计算。末尾固定为 `消息 ──`，与左侧工作状态的 `── ` 前缀对称。
- 多行合并为一行，图片显示为 `[image]`，移除终端控制序列。
- 左侧至少留 40 列给 Pi 原生的 `Working`、重试、压缩状态及输入滚动提示。窗口不足 84 列时预览缩短，不足 52 列时隐藏。
- 启动、恢复、reload 和会话树切换时，从当前分支还原上一条用户消息；空分支清空预览。
- 草稿和排队中尚未进入会话的消息不更新预览；RPC、JSON、print 模式不启用。
- 可独立加载，也可与包内的 mode-switching、subagent 编辑器一起使用；不改变输入、快捷键或光标行为。

无需配置，随仓库根 `package.json` 的 `pi.extensions` 自动加载。

## 边界

使用 Pi 编辑器的 `renderTopBorder` 钩子，保留原有的工作状态和滚动提示。第三方编辑器如果没有这个钩子，则不显示预览；第三方扩展在启动完成后完全替换编辑器时，也可能移除预览。Pi 升级后需重新验证钩子兼容性。

## 自检

`check.ts` 使用真实的 Pi `CustomEditor` 和模拟会话，不调用模型，不需要终端或新增依赖。它检查宽字符截断、窄窗口、主题更新、控制序列过滤、分支恢复、非 TUI 模式，以及与 mode-switching 组合后上下边框 `── ` 前缀一致、工作状态块（包含 spinner）与模式标签的对齐和反复 turn 的稳定性。

与普通 `node --test` 不同，这个接线检查需要 Pi 的 jiti 模块别名。在仓库根目录运行，将第一行改为本机 Pi 安装中包含 `@earendil-works` 和 `jiti` 的 `node_modules` 路径：

```bash
export PI_NODE_MODULES=/path/to/pi/node_modules
node --unhandled-rejections=strict --input-type=module <<'NODE'
import { createRequire } from 'node:module';
const root = process.env.PI_NODE_MODULES;
const requirePi = createRequire(`${root}/@earendil-works/pi-coding-agent/package.json`);
const { createJiti } = requirePi('jiti');
const alias = Object.fromEntries([
  '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui',
].map(name => [name, `${root}/${name}/dist/index.js`]));
alias['@earendil-works/pi-ai'] = `${root}/@earendil-works/pi-ai/dist/compat.js`;
for (const name of ['typebox', 'typebox/compile', 'typebox/value']) alias[name] = requirePi.resolve(name);
const jiti = createJiti(`${process.cwd()}/package.json`, { alias, moduleCache: false, fsCache: false });
await jiti.import(`${process.cwd()}/pi-lastssermessage/check.ts`);
NODE
```

实际终端仍需检查 regular / fullscreen 两种模式下的窗口缩放、中文输入光标及 Shift+Tab 模式切换。
