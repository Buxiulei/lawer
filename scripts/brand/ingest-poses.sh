#!/usr/bin/env bash
# 把五张吉祥物姿势原图压成产线 webp。源图在仓外（素材/品牌/），产物入 app/public/brand/。
# 尺寸不是拍脑袋：每张按它**实际渲染的 CSS 尺寸**乘 2.3～3.4 倍出一档，不出用不上的档。
# 催办那张单独裁上 55%——全身在小圆角标里会糊成一团棕色，闹钟（愤怒的指向物）会整个消失。
#
# 【尺寸标准 2026-08-29 提高】判据从「认得出形」提到「看得清表情」（用户：太小了看不清）。
# 5× 放大逐档实测：守望 28 一团、36 只有眼镜暗带、44 认得出形、**52 眼睛与神情读得出**；
# 催办裁切版 32 嘴只是暗点、40 勉强、**48 皱眉与张嘴都清楚**。⇒ 渲染定 56 / 48，源档相应提到 160 / 144。
set -euo pipefail
SRC="${BRAND_SRC:-/home/roots/裁员应对员/素材/品牌}"
OUT="$(cd "$(dirname "$0")/../../app/public/brand" && pwd)"

python3 - "$SRC" "$OUT" <<'PY'
import sys, io, subprocess
from PIL import Image
src, out = sys.argv[1], sys.argv[2]

# (源文件, 产物名, 边长px, 裁切比例None=整只)
JOBS = [
    ('守望', 'pose-watch',  160, None),   # 驾驶舱常驻小标 56px
    ('催办', 'pose-nag',    144, 0.55),   # 期限角标 48px 圆形
    ('护住', 'pose-guard',  160, None),   # 固化回执 64px
    ('庆祝', 'pose-cheer',  224, None),   # 里程碑 96px
    ('引导', 'pose-guide',  360, None),   # 空态 160px
]

for zh, name, px, crop in JOBS:
    im = Image.open(f'{src}/土八鼠-{zh}.png').convert('RGBA')
    im = im.crop(im.getchannel('A').getbbox())          # 去掉原图四周的空白
    if crop:
        im = im.crop((0, 0, im.width, int(im.height * crop)))
    w, h = im.size
    s = max(w, h)
    sq = Image.new('RGBA', (s, s), (0, 0, 0, 0))        # 补成正方形，落位时不用算比例
    sq.paste(im, ((s - w) // 2, (s - h) // 2), im)
    sq = sq.resize((px, px), Image.LANCZOS)
    path = f'{out}/{name}-{px}.webp'
    sq.save(path, 'WEBP', quality=88, method=6)
    print(f'{path}  {px}px  {round(len(open(path,"rb").read())/1024,1)}KB')
PY
