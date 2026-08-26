# 心跳档已迁出版控（2026-08-26）

**唯一真源**：`/home/roots/caiyuan-ws/heartbeats/<角色>.txt`
**写法**：一律用 `/home/roots/caiyuan-ws/heartbeats/hb.sh`，不要手写、不要 touch。

## 为什么搬走

心跳在版控内 → 同一份档在每个 clone/worktree 各有一份副本（2026-08-26 实测全机 **59 份**，
分布在 10 个工作树），且 **mtime 会被 checkout 刷新**。
后果：「心跳没更新」「更新在别处」「根本没有档」这三种情况在观察端**长得完全一样**。

## 三个已踩过的坑

1. **`hb.sh` 用 `dirname $0` 定位写入目标** —— 复制出第二份，那份就会往副本自己的目录写，
   不报错、内容看着完全正常，只是没人读。**全机只许存在一份 hb.sh。**
2. **文件更大、mtime 更新 ≠ 内容更新**。援助律师的档：182B 那版内容是 08-23，
   6 个 clone 里 246B 那版内容是 08-21 —— 大的、新的那版内容反而旧 3 天。
   **对账不许只看 mtime 或只看大小。**
3. **mtime 只有在新位置被真实写入过至少一次之后才可信**。在那之前它是 cp/checkout 的产物。
   存活探针对未达标的档一律跳过且写进日志，不静默跳过、不告警。

## 行格式分界线

`hb.sh` 口径是 `时间戳|状态|内容`。前端页面档 2026-08-26 09:57 之前的 47 行是
`时间戳|内容|状态`（反的），**历史行不改写**——改了等于伪造过去的记录。
按位置取字段的对账脚本注意这条分界线。

## ⚠️ 核验残留时不许用 `git status`

本次修复**自己造出了一个盲区**，写在这里因为下一个人一定会踩：

`.gitignore` 加了 `docs/tasks/heartbeats/*.txt` 之后，**残留的 `.txt` 从此永远不会出现在
`git status` 里**。谁用 `git status` 验"清干净了没有"，会永远得到"干净"——
而那句"干净"什么都不代表。

**活样本**（2026-08-26 10:04 实测）：`caiyuan-ws/backend` 里 `MOVED.md` 已经有了、
`git status` 干净、`后台技术.txt` 还在那儿躺着。

**核验残留一律用 `ls docs/tasks/heartbeats/`，不用 `git status`。**
本目录下除 `MOVED.md` 外的任何 `.txt` 都是僵尸副本，删掉即可（真源在 caiyuan-ws）。

## 各工作树不能靠 `pull` 统一收尾

2026-08-26 实测 11 个工作树，**只有 `caiyuan-ws/frontend` 一个能靠 `pull` 解决**（它在 main 上）。
其余的形状各不相同，**别写成"逐个 pull 即可"**：
- `eval`（detached HEAD）、`ws2-a`、`ws2-b` —— **无上游，根本 pull 不了**
- `knowledge`、`wt-integration` —— 上游是 `origin/main` 但分支不是 main，
  `pull` 等于把 main 合进 feature 分支，**不是无害操作**
- `lawer` 本体 —— 带未提交的心跳档修改，合入会撞 **modify/delete 冲突**
- 其余在各自 feature 分支上，得等分支合 main
