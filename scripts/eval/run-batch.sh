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
echo done >"$OUT/DONE"
