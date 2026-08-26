#!/bin/sh
# 把一批评测产物复制到**非一次性**的归档位置，并当场自证复制成功。
#
#   用法: archive-batch.sh <产物路径> [更多产物路径...]
#   例:   sh scripts/eval/archive-batch.sh results/评测官/batch-xxx results/2026-*.json
#         sh scripts/eval/archive-batch.sh /tmp/.../scratchpad/s08-evidence
#
#   环境变量 EVAL_ARCHIVE_DIR 可改归档根目录（默认 ~/caiyuan-ws/eval-evidence-archive）。
#   成功打印归档绝对路径（调用方可把它记进 META）；任一件没归到就非零退出。
#
# ═══ 为什么有这个脚本（2026-08-26） ═══
#
# 规矩（manager 定稿）：
#   **跑批可以在一次性目录里（worktree / scratchpad / 会话临时目录）进行——隔离正是它的价值；
#     但产物不许只落在那里，每一批产物必须同时落到一个非一次性的位置。**
#   **"我先拷了一份"不算，要看拷去了哪儿；归档的定义是"别人能独立找到并核对"，不是"我手上还有"。**
#
# 事故：`fb8257d` 那两份 S08 转录随 `~/caiyuan-ws/ws2-s08` worktree 一起没了。
# 它们是一份成绩单与断代册「断代点二」的唯一底稿。**这次没出事，靠的是有人删之前顺手拷了一份**
# ——而且拷去了会话级临时目录，只是把"一个会被删的位置"换成了"另一个会被删的位置，且别人找不到"。
# **那是一个人的谨慎，不是一个机制。**
#
# ═══ 为什么它是独立脚本而不是 run-batch.sh 里的一段 ═══
#
# 出事那次是**手工跑批**（三版离线重打分、blob 比对、变异矩阵，全是一次性脚本），
# 根本不走 `run-batch.sh`。**只有规矩没有入口，等于要求每个人自己实现一遍归档
# ——而自己实现的那份，就是下一个只存在于一处的东西。**
# 规矩负责覆盖"想不起来调"的情况；这个入口负责让"想起来了"的人一行就能做到。
set -u
[ $# -ge 1 ] || { echo "用法: $0 <产物路径> [更多...]" >&2; exit 2; }

ROOT=${EVAL_ARCHIVE_DIR:-$HOME/caiyuan-ws/eval-evidence-archive}
DEST=$ROOT/$(date +%Y-%m-%d)
mkdir -p "$DEST" || { echo "归档目录建不出来：$DEST" >&2; exit 3; }

n_ok=0
n_bad=0
n_skip=0
for src in "$@"; do
  [ -e "$src" ] || { echo "跳过（不存在）：$src" >&2; n_bad=$((n_bad+1)); continue; }
  base=$(basename "$src")
  # 【先看目的地原来有没有】`cp -n` 遇同名不覆盖、且**静默**。若只在复制后检查"存在不存在"，
  # 同名已存在的情况会让自证**因为错误的原因通过**：什么都没复制，而检查看见的是旧副本。
  # 这正是今天反复出现的形状——一个检查通过了，但它证明的不是它声称的那件事。
  # 保留 `-n`（归档过的证据不许被覆盖），但把"已存在"报成独立结局，不混进成功。
  if [ -e "$DEST/$base" ]; then
    echo "已存在，未覆盖（归档不覆盖既有证据）：$DEST/$base" >&2
    n_skip=$((n_skip+1))
    continue
  fi
  cp -rn "$src" "$DEST/" 2>/dev/null
  # 【逐件自证，不数总数】复制静默失败与"本来就没有这一件"长得一模一样。
  # 只报一个总数挡不住"其中某一件没归到"——而缺的那一件，通常正是日后有人要找的那一件。
  if [ -e "$DEST/$base" ]; then
    n_ok=$((n_ok+1))
  else
    echo "归档自证失败：$src → $DEST/$base 不存在" >&2
    n_bad=$((n_bad+1))
  fi
done

[ "$n_bad" -eq 0 ] || { echo "归档未完成：$n_ok 新归 / $n_skip 已存在 / $n_bad 失败" >&2; exit 4; }
[ $((n_ok + n_skip)) -gt 0 ] || { echo "归档自证失败：一件都没归到（参数里的路径可能都不存在）" >&2; exit 4; }
[ "$n_skip" -eq 0 ] || echo "注意：$n_skip 件在归档里已存在、本次未覆盖" >&2
echo "$DEST"
