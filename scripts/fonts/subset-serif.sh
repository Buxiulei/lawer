#!/bin/sh
# scripts/fonts/subset-serif.sh
#
# 重新生成落地页衬线子集字体。**改了落地页静态文案就要重跑这个脚本**，
# 否则新字会静默掉回系统栈渲染——`landing-serif-coverage.test.ts` 会在那之前先报红。
#
# 【为什么自托管子集而不是 Google Fonts】
# 用户在北京朝阳，`fonts.googleapis.com` 对他们是死链。
# 整包 CJK webfont 又太重（NotoSerifCJK 单档 26MB）。
# 只喂落地页真正用到的 ~300 字，单档约 54KB。
# 只做 Bold 一档：常规字重原先只服务草稿纸那段示例文字，为它多背 52KB 不划算。
#
# 【为什么只喂静态文案】
# 案件名、用户输入这类动态文本一律走 --font-serif-dynamic（纯系统栈）。
# 子集里必然缺那些字，混用会出「覆盖到的字是衬线、缺的字掉回无衬线」的缺字混排。
#
# 依赖：fontTools + brotli（PEP 668 环境下装在 venv 里，别装进系统 python）
#   python3 -m venv /tmp/fontvenv && /tmp/fontvenv/bin/pip install fonttools brotli
# 字体源：Debian/Ubuntu 包 fonts-noto-cjk，SIL OFL 1.1，允许子集化与再分发。
#
# ⚠️ **--font-number=2 是 SC**。ttc 里的顺序是 JP(0) / KR(1) / SC(2)；
#    用错了照样产出体积正常、格式正确、能加载的文件，**里面却是日文字形**。
set -eu
VENV="${FONT_VENV:-/tmp/fontvenv}"
SRC_DIR="${NOTO_DIR:-/usr/share/fonts/opentype/noto}"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="$HERE/../../app/public/fonts"
CHARS="$HERE/landing-chars.txt"

[ -x "$VENV/bin/pyftsubset" ] || { echo "缺 $VENV/bin/pyftsubset，先建 venv 装 fonttools brotli"; exit 1; }
[ -f "$CHARS" ] || { echo "缺字符清单 $CHARS"; exit 1; }

for pair in "Bold:tubashu-serif-700"; do
  W=${pair%%:*}; NAME=${pair#*:}
  "$VENV/bin/pyftsubset" "$SRC_DIR/NotoSerifCJK-$W.ttc" \
    --font-number=2 \
    --text-file="$CHARS" \
    --output-file="$OUT/$NAME.woff2" --flavor=woff2 \
    --layout-features='' --no-hinting --desubroutinize
  printf '  %s.woff2  %s\n' "$NAME" "$(du -h "$OUT/$NAME.woff2" | cut -f1)"
done

# 产出自证：确认真的是 SC face，不是 JP
"$VENV/bin/python" - "$OUT" <<'PY'
import sys
from fontTools.ttLib import TTFont
for n in ('tubashu-serif-700',):
    f=TTFont(f'{sys.argv[1]}/{n}.woff2')
    name=f['name'].getDebugName(4)
    assert 'SC' in name, f'{n}: 内部名是 {name}，不是 SC face——检查 --font-number'
    print(f'  {n}: {name}  字形 {f["maxp"].numGlyphs}')
PY
