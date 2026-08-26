#!/bin/sh
# 列出可用于统计的评测转录，**按内容去重**。任何"N 轮语料里 X 次"的统计都该从这里取文件。
#
#   用法: sh scripts/eval/corpus-list.sh              # 每行一个 json 路径（按**文件**内容去重）
#         sh scripts/eval/corpus-list.sh --count      # 打印 去重后/去重前 两个数（文件层）
#         sh scripts/eval/corpus-list.sh --scenarios  # 每行 `路径<TAB>剧本下标`（按**剧本实例**去重）
#
# ⚠️ **做轮数/命中率统计一律用 `--scenarios`，不要用默认的文件清单。**
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
# ═══ 两种重复机制，两个去重单位（2026-08-26，第一版只处理了其中一种）═══
#
# **机制一·同一份文件被归档留了两处**（本文件立的归档造的）。文件哈希能去掉。
# **机制二·同一份剧本结果装在两个信封里**：`runId` / `startedAt` 不同 ⇒ **文件哈希不同**，
#   而 `scenarios[0]` **逐字节相同**。实测 6 组（08-21 那批 S04/S05/S07/S09/S14/S15），
#   **全部不同名**。它比归档机制早五天，与归档无关。
#
# ⇒ **第一版的去重单位是「文件」，而重复发生在「剧本实例」这一层。**
#   **同一份剧本结果装在两个时间戳不同的信封里——按信封去重，永远看不见它。**
#
# 【这一版为什么会漏，值得留着】造第一版时我手里的证据只有那 2 组同名重复
#（我自己归档造的），**它对着那个证据是正确的**。问题是**证据只覆盖了一种重复机制**。
# ——而且这次的偏差**不离谱**：136→134 看着完全合理，157 vs 153 只差 2.6%，
# **它不触发任何人的"这个数不该是这样"。靠发愣抓住的都是离谱的错；
#   不离谱的错，只能靠"单位对不对"来抓。**（后台技术语，收）
#
# 【实测：单位选错到底会扭曲什么】那 6 个重复实例**全是 HTTP 失败记录、轮数为 0**，
# 所以**轮数统计两种粒度都是 153，一个字不差**——本次修的不是一个错数字，是一个错单位。
# 但**实例级统计当场被扭曲**：
#     文件层去重   134 个实例 / 失败 15 ⇒ 失败率 **11.2%**
#     实例层去重   128 个实例 / 失败  9 ⇒ 失败率 **7.0%**
# **相对高估 60%，而 11.2% 这个数本身一点也不离谱。**
# ⇒ 这就是为什么不能"先接入口再慢慢改"：**一个不离谱的偏差一旦进了唯一真源，
#   它就再也不会被发愣抓住了。**
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

if [ "${1:-}" = "--scenarios" ]; then
  # 剧本实例层去重：同一份 scenarios[i] 只留第一次出现。输出 `路径<TAB>下标`。
  printf '%s\n' "$DEDUP" | python3 -c '
import hashlib, json, sys
seen = set()
for line in sys.stdin:
    f = line.strip()
    if not f: continue
    try: d = json.load(open(f))
    except Exception: continue
    for i, sc in enumerate(d.get("scenarios", [])):
        h = hashlib.sha256(json.dumps(sc, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        if h in seen: continue
        seen.add(h)
        print(f"{f}\t{i}")
'
elif [ "${1:-}" = "--count" ]; then
  printf '去重后 %s 份 / 去重前 %s 份\n' "$(printf '%s\n' "$DEDUP" | grep -c .)" "$(list_all | grep -c .)"
else
  printf '%s\n' "$DEDUP"
fi
