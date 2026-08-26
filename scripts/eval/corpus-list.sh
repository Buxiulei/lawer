#!/bin/sh
# 列出可用于统计的评测转录，**按内容去重**。任何"N 轮语料里 X 次"的统计都该从这里取文件。
#
#   用法: sh scripts/eval/corpus-list.sh            # 每行一个 json 路径
#         sh scripts/eval/corpus-list.sh --count    # 只打印 去重后/去重前 两个数
#
# ═══ 为什么必须有它（2026-08-26） ═══
#
# 今天立的「跑完即归档」**按设计把同一份转录同时留在两处**：`scripts/eval/results/` 与
# `~/caiyuan-ws/eval-evidence-archive/`。**这不是 bug，这正是归档的目的**——
# 但任何同时扫这两处的统计会把同一轮数两遍。
#
# **当天就出事了**：我报「157 轮语料、13 段判 ≥2」，后台技术报「153 段、11 段」，
# 我们一度把它当成"两个口径独立数到同一结论"而互相加成。实测：差额 4 轮 / 2 段
# **正好是我归档的那 2 份转录的副本**。
# ⇒ **我们差点用"两人独立验证"给一个部分重叠的样本背书。**
#
# 【为什么按内容哈希而不是文件名】后台技术实测：8 个重复实例里**只有 2 个同名**，
# 另外 6 个同内容不同名——**文件名去重完全看不见**。
#
# 【为什么是脚本不是一条规矩】"记得去重"要人记得，而**这个分母只会随归档越来越胖**：
# 归档机制是今天刚立的，此后每一条统计都在这个膨胀的分母上。
# 规矩负责覆盖"想不起来"，这个入口负责让"想起来了"的人一行就能做对。
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ARCH=${EVAL_ARCHIVE_DIR:-$HOME/caiyuan-ws/eval-evidence-archive}

# 归档优先：同内容时留归档那份（它在非一次性位置，`results/` 可能随工作副本消失）
list_all() {
  find "$ARCH" -name '2026-*.json' -type f 2>/dev/null
  find "$ROOT/scripts/eval/results" -maxdepth 1 -name '2026-*.json' -type f 2>/dev/null
}

# 【为什么用 cut -f2- 而不是 awk '$1=""'】第一版用的是 awk：`$1=""` 之后 awk 会按 OFS
# 重建整行，留下**一个**前导空格，而我按"两个空格"去剥——**剥不掉，路径带着前导空格出去**，
# 下游 readFileSync 全部失败、被 try/catch 吞掉，读数器打出一个**看起来完全合法的 0 轮**。
# 用 TAB 分隔 + `cut -f2-` 不重建行，没有这个面。
DEDUP=$(list_all | while IFS= read -r f; do
  printf '%s\t%s\n' "$(sha256sum "$f" | cut -c1-16)" "$f"
done | sort -k1,1 -t"$(printf '\t')" -u | cut -f2-)

if [ "${1:-}" = "--count" ]; then
  printf '去重后 %s 份 / 去重前 %s 份\n' "$(printf '%s\n' "$DEDUP" | grep -c .)" "$(list_all | grep -c .)"
else
  printf '%s\n' "$DEDUP"
fi
