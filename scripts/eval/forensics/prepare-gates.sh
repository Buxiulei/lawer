#!/bin/sh
# 把三版（或四版）杠杆闸的 crisis.ts **原样**导出到 ./_gates/，供本目录的脚本静态 import。
# 原样导出＝零转写：转写一次，整个对照就不再是"用产线代码判的"。
# 用法：sh scripts/eval/forensics/prepare-gates.sh [SHIP_SHA]
set -eu
D=$(dirname "$0")/_gates
mkdir -p "$D"
git show 1c05f28:app/src/lib/agent/crisis.ts > "$D/gateA.ts"   # A = 线上/main 现状（无来源判别）
git show 2f32321:app/src/lib/agent/crisis.ts > "$D/gateB.ts"   # B = 只有第一层
git show fb8257d:app/src/lib/agent/crisis.ts > "$D/gateC.ts"   # C = 第一层 + 第二层
git show "${1:-fbafe4e}:app/src/lib/agent/crisis.ts" > "$D/gateSHIP.ts"  # 滚更包那棵树
echo "已导出到 $D："; ls -1 "$D"; md5sum "$D"/*.ts
