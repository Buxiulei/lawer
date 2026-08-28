#!/bin/sh
# 评测官定版批：固定 SHA × N 连跑 × 剧本。用法: run-batch.sh <SHA> <N> <剧本...>
# 例: nohup sh run-batch.sh abc1234 5 S08 S15 >/dev/null 2>&1 &
# 停批只杀本路径: pkill -f "caiyuan-ws/eval/.*eval-agent"; 计数: pgrep -fc "caiyuan-ws/eval/.*eval-agent"
set -u
SHA=$1; N=$2; shift 2; SCN="$*"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/scripts/eval/results/评测官/batch-$(date +%Y%m%dT%H%M%S)-$SHA
mkdir -p "$OUT"; echo $$ > "$OUT/run.pid"   # 停批: kill -- -$(cat run.pid)（只停本支，绝不 pkill 按名）
cd "$ROOT" || exit 2
# 【记住开批前在哪个 ref 上，跑完接回去 · 2026-08-27 踩过】
# 下面会 `git checkout <SHA>` 把 HEAD 钉在固定版本（这是对的，批内一致性要靠它），
# **但跑完不接回去，之后的提交就落在游离头上**——而 `git push origin <分支>` 这时会回一句
# **「Everything up-to-date」**：它推的是分支 ref，而你的提交不在分支上。
# **动作没发生，输出却像成功。** 这一族今天已经数到第七次。
START_REF=$(git symbolic-ref --quiet --short HEAD || echo "")
# 【开批时就游离 ⇒ 不接回，但必须说出来 · 2026-08-28 踩过】
# 「不猜用户想回哪儿」是对的，**但一声不吭不对**：本批开跑时 HEAD 已游离（上一批之后
# 我在游离头上提交并直推远端），于是接回段被静默跳过、META 里没有 head_restored_to，
# **而"没有这一行"与"接回失败"、"脚本是旧版"在产物上长得一样**。
# 后果：本地分支停在四个提交之前，而我一直以为自己在分支上。
STARTED_DETACHED=0
if [ -z "$START_REF" ]; then
  STARTED_DETACHED=1
  echo "⚠️ 开批时 HEAD 已是游离态（$(git rev-parse --short HEAD)）——跑完**不会**接回任何分支。" >&2
  echo "   这时候提交会落在游离头上，而 \`git push origin <分支>\` 会回 Everything up-to-date。" >&2
fi
# ═══ 接回段：改成 trap EXIT · 2026-08-28 第四次同型 ═══
# 【为什么必须是 trap】接回这段我前后加固过三次（没接回／接回到旧地方／开批即游离），
# **三次加固全都假设脚本能走到那一行**。而 S03 对照批（被测 SHA 早于本工具引入）
# 在归档段 `exit 4`，**接回段根本没被执行**，HEAD 被留在游离态。
# **一个只在正常路径上执行的清理动作，不是清理动作。**（manager 2026-08-28 入册）
# ⇒ 挂 EXIT：无论正常结束、`exit N` 还是被信号打断，接回都跑。
# 【顺序】DONE 必须在接回与 META 落款**之后**才出现——等 DONE 的人读 META 时
# `head_restored_to` 必须已经在纸上，否则又是"看起来正常"的一格。
restore_head() {
  rc=$?
  [ "$STARTED_DETACHED" = 1 ] && echo "head_restored_to=（开批时即游离，未接回）" >>"$OUT/META"
  if [ -n "$START_REF" ]; then
  # 【接回之前先看游离头上有没有新提交 · 2026-08-28 踩过第二次】
  # 上一版只管"接回分支"，但**批跑着的时候我在游离头上提交并直推了远端**，
  # 于是本地分支 ref 落后于远端，接回它 ⇒ **把工作区静默倒回**，
  # 而我拿倒回后的旧脚本跑了读数器、差点把一个硬编码的旧基线当成自算结果报出去。
  # ⇒ **「接回分支」不等于「接回到最新」。** 本地 ref 可能比你刚做的事旧。
  DETACHED_HEAD=$(git rev-parse HEAD)
  if ! git merge-base --is-ancestor "$DETACHED_HEAD" "$START_REF" 2>/dev/null; then
    echo "⚠️ 游离头 $(git rev-parse --short "$DETACHED_HEAD") 上有提交不在 $START_REF 上——" >&2
    echo "   接回会把它们从工作区拿掉。先 git fetch && git merge --ff-only origin/$START_REF 再干活。" >&2
    echo "detached_had_extra_commits=1" >>"$OUT/META"
  fi
  git checkout -q "$START_REF" 2>/dev/null || echo "⚠️ 接回 $START_REF 失败，HEAD 仍游离——提交前先 git checkout $START_REF" >&2
  # 【接回也要自证】checkout 失败与成功在下游长得一样：都是"没有报错的终端"。
  NOW=$(git symbolic-ref --quiet --short HEAD || echo "游离")
  [ "$NOW" = "$START_REF" ] || echo "⚠️ HEAD 现在是「$NOW」而不是「$START_REF」" >&2
  echo "head_restored_to=$NOW" >>"$OUT/META"
  fi
  [ -f "$OUT/.finished" ] && echo done >"$OUT/DONE"
  return $rc
}
trap restore_head EXIT
# 【EXIT 不够 · 停批走的正是信号】POSIX sh 的 EXIT trap **不接管 SIGTERM/SIGINT**。
# 而本文件头部写明的停批方式是 `kill -- -$(cat run.pid)`——发的就是 TERM。
# 不接这两个信号，**"手工停批"这条路径依然会把 HEAD 留在游离态**，
# 等于只修了我这次撞见的那一种退出方式。显式 `exit` 会触发 EXIT trap，接回照跑。
trap 'exit 143' TERM
trap 'exit 130' INT
：工作树必须干净且 HEAD==SHA，否则拒跑（批内一致性）
git fetch -q origin
# ═══ 开批前置：被测对象与工具链分离 · 2026-08-28 S03 对照批踩出 ═══
# 【病因】本脚本第一件事是 `git checkout <被测SHA>` **整棵树**——于是**它自己的工具链
# 也被钉到被测 SHA**。测 `06c6a3d` 时，`run-batch.sh` 与 `archive-batch.sh` 都还没被引入，
# **脚本在运行途中把自己删掉了**：`sh` 靠已打开的 fd 把三跑跑完（inode 未释放），
# 但归档段是**按路径**调 `archive-batch.sh` ⇒ 文件不在 ⇒ 失败 ⇒ 在接回段之前退出。
# 【修法】**被测对象该钉，工具不该钉。** 归档器开批前快照到 $OUT（results/ 已 gitignore，
# 挺得过 checkout），全程调副本。这样测任何历史 SHA 都不会把工具测没了。
git cat-file -e "$SHA:scripts/eval-agent.ts" 2>/dev/null \
  || { echo "被测 SHA $SHA 上没有 scripts/eval-agent.ts——被测对象不存在，拒跑" >"$OUT/FAILED"; exit 2; }
cp "$ROOT/scripts/eval/archive-batch.sh" "$OUT/.archive-batch.sh" \
  || { echo "归档器快照失败，拒跑（宁可不开批，也不要跑完发现归不了档）" >"$OUT/FAILED"; exit 2; }
git cat-file -e "$SHA:scripts/eval/archive-batch.sh" 2>/dev/null \
  || echo "toolchain_snapshotted=1（被测 SHA 早于归档器引入，全程用开批时的副本）" >>"$OUT/META"
git checkout -q "$SHA" || { echo "checkout $SHA 失败" >"$OUT/FAILED"; exit 2; }
[ -z "$(git status --porcelain -- app/src scripts knowledge)" ] || { echo "工作树不干净，拒跑" >"$OUT/FAILED"; exit 2; }
# 开批前余额/连通性冒烟：1 次最小调用，失败不起批
KEY=$(grep -m1 '^DEEPSEEK_API_KEY=' app/.env.local | cut -d= -f2- | tr -d '"'"'"'"')
code=$(curl -s -o "$OUT/smoke.json" -w '%{http_code}' https://api.deepseek.com/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"ping"}],"max_tokens":1}')
[ "$code" = 200 ] || { echo "冒烟失败 HTTP $code: $(head -c 200 $OUT/smoke.json)" >"$OUT/FAILED"; exit 2; }
# 【三维落款·第三维：知识库版本】（ws2 2026-08-25 提，评测官采纳）
# A17 落款已有「判据语义版本 + 被判行为 SHA」，缺第三维：**这一批用的是哪一版知识库**。
# index.json 受 git 版控 → worktree 在 SHA X 时知识库必然是 X 那版；把 blob 哈希写进 META，
# 事后可与声明 SHA 字节比对：知识库版本从此**可验**而不是**可信**。
KB_BLOB=$(git rev-parse HEAD:knowledge/index.json 2>/dev/null | cut -c1-8)
# 【前置校验】打印实际解析到的知识库绝对路径与卡数——cwd 决定解析结果（2026-08-25 cwd 事件），
# 跑批必须自证"我加载的是哪一个库"，对不上就别开批。
KB_DIR=$(cd app 2>/dev/null && node -e "console.log(require('path').resolve(process.cwd(),'..','knowledge'))" 2>/dev/null)
# 【2026-08-28 统一到 git 口径（manager 裁）】此前 `kb_cards` 数的是**文件系统**（find），
# 而同一行的 `kb_index_blob` 走 git——**两个字段并排印在"三轴戳"里，却不是同一个口径**。
# 实测差 1：`knowledge/TODO核实清单.md` 被 gitignore，于是 `kb_cards=220` 里
# **有一张不受任何 SHA 约束**，而戳的用途恰恰是"事后可与声明 SHA 字节比对"。
KB_CARDS=$(git ls-tree -r --name-only "$SHA" knowledge/ 2>/dev/null | grep -c '\.md$')
# 【文件系统那个数不删，降为对照】产线**实际加载的是磁盘、不是 git**，
# 所以"磁盘上有多少张"仍是要自证的（2025-08-25 cwd 事件就是靠它抓到的）。
# 两者不一致不拒跑——那不是错误，是"有未进版控的卡在参与检索"这一事实，**要说出来而不是抹平**。
KB_CARDS_FS=$(find "${KB_DIR:-/nonexistent}" -name '*.md' 2>/dev/null | wc -l)
case "$KB_DIR" in
  "$ROOT/knowledge") ;;
  *) echo "知识库解析异常：期望 $ROOT/knowledge，实得 ${KB_DIR:-空}" >"$OUT/FAILED"; exit 2 ;;
esac
[ "$KB_CARDS" -gt 100 ] || { echo "知识库卡数异常($KB_CARDS)，拒绝开批" >"$OUT/FAILED"; exit 2; }
# 归档用的时间基准：**开批那一刻**。不能用 META——它每跑都被追加，mtime 永远比转录新，
# 拿它当 `-newer` 基准会一条转录都找不到，而"找不到"与"本来就没有"长得一模一样。
touch "$OUT/.batch-start"
[ "$KB_CARDS" -eq "$KB_CARDS_FS" ] \
  || echo "kb_untracked_cards=$((KB_CARDS_FS - KB_CARDS))（磁盘上有未进版控的卡在参与检索，不受 SHA 约束）" >>"$OUT/META"
echo "kb_dir=$KB_DIR kb_cards=$KB_CARDS kb_cards_fs=$KB_CARDS_FS kb_index_blob=$KB_BLOB" >>"$OUT/META"
echo "sha=$(git rev-parse HEAD) n=$N scenarios=$SCN start=$(date -Is)" >>"$OUT/META"
# 【自证·2026-08-25 修】上一版这里是 `>` 截断写，把上一行的 kb_index_blob 冲掉了——
# **15 个历史批次无一记到第三轴**，而我对外一直说"批次带三轴戳"。
# 落款写完必须当场验它在不在，否则"我盖了戳"和"戳在纸上"又是两回事。
grep -q "kb_index_blob=" "$OUT/META" || { echo "三轴戳缺 kb_index_blob，拒绝开批" >"$OUT/FAILED"; exit 2; }
grep -q "^sha=" "$OUT/META" || { echo "三轴戳缺 sha，拒绝开批" >"$OUT/FAILED"; exit 2; }
cd app || exit 2
i=1
while [ $i -le "$N" ]; do
  for s in $SCN; do
    EVAL_DUMP=1 EVAL_RUN_NOTE="评测官定版批 $SHA 第${i}/${N}跑 剧本$s" \
      npx tsx ../scripts/eval-agent.ts "$s" >"$OUT/run${i}-$s.log" 2>&1
    rc=$?; echo "run=$i scenario=$s exit=$rc end=$(date -Is)" >>"$OUT/META"
    if grep -qE 'HTTP (402|429|5[0-9][0-9])|Insufficient Balance' "$OUT/run${i}-$s.log"; then
      echo "基础设施错误即停 run=$i scenario=$s: $(grep -oE 'HTTP [0-9]{3}[^\n]{0,80}' "$OUT/run${i}-$s.log" | head -1)" >"$OUT/FAILED"; exit 3
    fi
  done
  i=$((i+1))
done

# 【跑完即归档 · 2026-08-26 事故后加】归档实现在 `archive-batch.sh`，本脚本只调用它。
# **不在这里再写一份**——手工跑批的人也要能调同一个入口；两份实现里迟早有一份是坏的，
# 而坏的那份的症状（"归档了但找不到"）与没归档一模一样。规矩与理由见 archive-batch.sh 头部。
#
# 传两样：本批次目录 + 开批之后新落盘的转录。
# 基准用开批时 touch 的 `.batch-start`，**不能用 META**——META 每跑都被追加，
# mtime 永远比转录新，拿它当 `-newer` 基准会一条转录都找不到，
# 而"找不到"与"本来就没有"长得一模一样。（第一版就是这么错的，被自证当场抓住。）
ARCHIVE=$OUT/.archive-batch.sh   # 开批前的快照，不随被测 SHA 走（见上方前置段）
# 【为什么分两次调、而不是把文件名塞进一个变量】上一版写的是 `ARCH=$(... $TRANS)`，
# 依赖 shell 对未加引号变量做词分割——**而 zsh 默认不分割、sh 分割**。
# 同一行代码在两个 shell 下行为不同，我自己的仿真（跑在 zsh 里）就把两个路径当成了一个参数。
# `find -exec {} +` 把文件名作为真正的 argv 传过去，不经过分割，两个 shell 下一致。
ARCH=$(sh "$ARCHIVE" "$OUT") || { echo "批次目录归档失败" >"$OUT/FAILED"; exit 4; }
# 本批新落盘的转录。基准用开批时 touch 的 `.batch-start`，**不能用 META**——
# META 每跑都被追加，mtime 永远比转录新，拿它当 `-newer` 基准会一条转录都找不到，
# 而"找不到"与"本来就没有"长得一模一样。（第一版就是这么错的，被自证当场抓住。）
find "$ROOT/scripts/eval/results" -maxdepth 1 -newer "$OUT/.batch-start" \
  \( -name '*.json' -o -name '*.md' \) -exec sh "$ARCHIVE" {} + \
  || { echo "转录归档失败" >"$OUT/FAILED"; exit 4; }
echo "archived_to=$ARCH/$(basename "$OUT")" >>"$OUT/META"

echo done >"$OUT/.finished"

