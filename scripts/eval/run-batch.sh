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
# 开批前锁定版本：工作树必须干净且 HEAD==SHA，否则拒跑（批内一致性）
git fetch -q origin
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
KB_CARDS=$(find "${KB_DIR:-/nonexistent}" -name '*.md' 2>/dev/null | wc -l)
case "$KB_DIR" in
  "$ROOT/knowledge") ;;
  *) echo "知识库解析异常：期望 $ROOT/knowledge，实得 ${KB_DIR:-空}" >"$OUT/FAILED"; exit 2 ;;
esac
[ "$KB_CARDS" -gt 100 ] || { echo "知识库卡数异常($KB_CARDS)，拒绝开批" >"$OUT/FAILED"; exit 2; }
# 归档用的时间基准：**开批那一刻**。不能用 META——它每跑都被追加，mtime 永远比转录新，
# 拿它当 `-newer` 基准会一条转录都找不到，而"找不到"与"本来就没有"长得一模一样。
touch "$OUT/.batch-start"
echo "kb_dir=$KB_DIR kb_cards=$KB_CARDS kb_index_blob=$KB_BLOB" >>"$OUT/META"
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

# 【跑完即归档 · 2026-08-26 事故后加】把本批产物复制到**不在任何 worktree 内**的目录。
#
# 【事故】`fb8257d` 那两份 S08 转录随 `~/caiyuan-ws/ws2-s08` worktree 一并消失，全机搜不到——
# 而它们是一份成绩单与断代册「断代点二」的**唯一底稿**。后果不是少了两个文件，
# 是**两份已提交的结论从此不可复核**。
#
# 【根因】`.gitignore:18` 的注释写的是「留在服务器供验收查阅」，而实际跑批在**本地一次性 worktree** 里。
# **声明的存放地与实际的存放地不是同一个地方，而没人发现**——直到有人真去取它。
# 失败方向仍然是"让人放心"：证据看起来一直都在。
#
# 不改 `.gitignore`（转录含大段模型原文与案情夹具，那条政策有它的理由），
# 只保证**副本不再只存在于一个可被删除的工作副本里**。归档位置待 manager 定版，先落这个。
ARCH=${EVAL_ARCHIVE_DIR:-$HOME/caiyuan-ws/eval-evidence-archive}/$(date +%Y-%m-%d)
mkdir -p "$ARCH" || { echo "归档目录建不出来：$ARCH" >"$OUT/FAILED"; exit 4; }
cp -r "$OUT" "$ARCH/" 2>/dev/null
# 本批期间新落盘的转录（json/md），按批次开始时间之后取
find "$ROOT/scripts/eval/results" -maxdepth 1 -newer "$OUT/.batch-start" \( -name '*.json' -o -name '*.md' \) \
  -exec cp -n {} "$ARCH/" \; 2>/dev/null
NARCH=$(find "$ROOT/scripts/eval/results" -maxdepth 1 -newer "$OUT/.batch-start" -name '*.json' | wc -l)
# 【归档必须自证】复制静默失败与"没东西可复制"长得一模一样——本文件开头那条
# 三轴戳自证是同一个道理：**落款写完必须当场验它在不在**。
[ -f "$ARCH/$(basename "$OUT")/META" ] || { echo "归档自证失败：$ARCH 下找不到本批 META" >"$OUT/FAILED"; exit 4; }
# 只验批次目录挡不住"转录一份都没归到"——那正是上一版 `-newer META` 会造成的静默失败。
[ "$NARCH" -gt 0 ] || { echo "归档自证失败：本批转录 0 份被归档（find 基准或 results 路径不对）" >"$OUT/FAILED"; exit 4; }
echo "archived_to=$ARCH/$(basename "$OUT")" >>"$OUT/META"

echo done >"$OUT/DONE"
