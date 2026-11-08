---
name: issue-workflow
description: 批量实现一个 issue 目录:按 `Blocked by` 建 DAG,用 5 个 git worktree 组成并行池(一个在跑的 issue 占一个 worktree),子代理返回后立刻合并回主干、收口 Status、补下一个可开工 issue,直到全部 resolved。触发词:issue workflow、批量实现 issue、并行跑 issues。
disable-model-invocation: true
---

# Issue Workflow

DAG 调度 + 并行池:同时最多 5 个 issue 在跑,各在自己的 worktree 里由一个全新子代理实现 + 自测 + 自审 + 提交。主代理只做排序、建/拆 worktree、派发、串行合并、收 Status。

```
07 → 08 → 09,10 → 11      06      12
01 → 02 → 03 → 05
01 → 04 → 05
```

上例满员时 07 / 01 / 06 / 12 同时跑;01 完事立刻有 02、04 补位,轮到 05 时它已经拿到 03、04 两条腿。

## 前置

- `subagent` 工具(全局 subagent 扩展提供;没有就报错,别自己造轮子)
- agent 用 `general`(`delegate` 不存在)
- 并发上限默认 4;跑 5 路要先 `export PI_SUBAGENT_MAX_CONCURRENCY=5` 再**重启 pi**(本仓库 `subagent/index.ts` 读这个变量)
- issue 遵循仓库 issue-tracker 约定:顶部 `Status:` 行,`Blocked by` 列 `- #NN`
- 主 checkout 干净:`git status --porcelain` 非空就停,让用户先提交或 stash
- `.pi/` 下放 worktree(第 3 步会补 exclude)

## 1. 解析

- 列目录下所有 `NN-<slug>.md`(忽略 `PRD.md`、`map.md` 等非 issue 文件)
- 每个读 `Status` 与 `Blocked by`(同一行或 `## Blocked by` 小节里都可能)
- 可开工 = Status 为 `ready-for-agent` 或缺省,且依赖全部 `resolved` / `done`;`claimed`、`wontfix` 跳过
- 目录不存在或没有 issue 文件 → 报错,不执行

## 2. 建图

- 边:NN → 它 `Blocked by` 列出的 issue
- 派发顺序:文件序号升序;文件里写了「建议排在 NN 后」的排在同序号组末尾(软优先级,不算依赖边)
- 有未完成 issue 但没有可开工项 → 停,报告依赖环或上游未完成

## 3. 补满池子(最多 5)

worktree 放项目根的 `.pi/` 下,但必须先把 `.pi/` 写进本地 exclude(否则它变成未跟踪文件,污染 `git status` 和子代理的 `git add -A`):

```
ROOT=$(git rev-parse --show-toplevel)
WT_ROOT="$ROOT/.pi/issue-worktrees"
BASE=$(git rev-parse --abbrev-ref HEAD)      # 合并目标分支
git check-ignore -q .pi || printf '.pi/\n' >> "$(git rev-parse --git-common-dir)/info/exclude"
git worktree add "$WT_ROOT/issue-NN" -b "issue/NN" "$BASE"
```

走 `.git/info/exclude` 而不是 `.gitignore`:本地生效、不进仓库、不用提交,所有 worktree 共用。

已有同名分支或 worktree → 先 `git worktree list` 看清,禁止 `-B` 覆盖未合并的旧提交。别在主 checkout 跑 `git clean -xdf`——未合并的 worktree 一起没了。

一次 `subagent` 调用派掉当前 frontier 的前 N 个(各自 `cwd` 指向自己的 worktree):

```
subagent({
  tasks: [
    {
      agent: "general",
      cwd: "$WT_ROOT/issue-NN",
      task: "/skill:implement <issue 绝对路径>\n\n只改代码和测试,不要动 issue 文件本身(Status 由主代理维护)。完成后 `git add -A && git commit`,工作树必须干净(含 CONTEXT.md / AGENTS.md 等文档改动)。"
    }
    // 同批其余 issue 各一条
  ]
})
```

测试争用固定端口 / 数据库时降 N,别硬并行。

## 4. 回收(整批返回后逐个做,顺序按依赖)

对每个 issue:

1. `git -C "$WT" status --porcelain` 必须为空——非空 = 没提交,本 issue 失败
2. `git -C "$WT" log --oneline "$BASE..HEAD"` 必须有提交,记下范围
3. 主 checkout 合并:`git merge --no-ff "issue/NN"`
   - 冲突 → `git merge --abort`,再 `git -C "$WT" rebase "$BASE"`,干净则重试一次合并;仍有冲突 → 本 issue 失败
4. 成功 → `git worktree remove --force "$WT" && git branch -d "issue/NN"`,Status 改 `resolved`(依赖判断的唯一真源),一条 `git commit -am "chore(issues): mark NN resolved"`

一批收完回到第 3 步补下一批,直到没有可开工项。

已知限制:一次 `subagent` 调用要等整批返回,所以是「批内并行 + 批末补位」,不是逐槽异步——批里先跑完的 issue 空出的槽要等同批最慢的返回才能补。

## 5. 失败

某 issue 失败 → 它和它的下游全部标 blocked,不再派;其它在跑的照常回收,能开工的继续。收尾时一次报告:停在第几个 issue、子代理最后一段输出、`git status`、哪些下游被连带卡住。

## 6. 汇总

每个 issue 成功/失败 + commit + 冲突重试次数;末尾 `git log --oneline <起始 SHA>..HEAD`,`git worktree list` 必须只剩主 checkout。
