#!/usr/bin/env python3
"""把 app/public/brand/ 的产线 webp 转成邮件能用的 PNG，写成 base64 常量模块。

    python3 scripts/brand/make-email-assets.py

产物：app/src/lib/notify/brand-assets.ts（**已提交进仓，本脚本只在换素材时重跑**）

【为什么邮件不能直接用 public/brand/ 那几张 webp】
Outlook 桌面版走 Word 渲染引擎，不认 WebP；旧版 Apple Mail 也不认。
站内页面用 webp 没问题，邮件必须退回 PNG——**这不是保守，是那批客户端根本画不出来**。

【为什么把字节码写进 .ts，而不是运行时 fs 读 public/】
读文件要有个能解析对的根目录，而这套代码有三个互不相同的运行位置：
Next 服务端（cwd=app）、`npx tsx ../scripts/deadline-reminder.ts`（cwd 由 cron 定）、vitest。
路径推错的表现是**邮件照发、图片静默消失**——发出去了才知道，且收件人不会来报。
编进模块里就没有"推错"这一步：编译期就在，或者根本编不过。

【为什么调色板量化】原图 RGBA 直转 PNG 是 23KB/44KB，两张就把源文件撑到 90KB base64。
64 色量化后 5.3KB/7.6KB，放大 5 倍目视与原图无差（这两张本来就是厚涂平色的卡通）。
先合成到白底再量化：邮件卡片底色就是白色，留 alpha 只会让不认 PNG 透明的客户端画出黑边。
"""

import base64
import io
import pathlib
import sys

from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE.parent.parent / 'app' / 'public' / 'brand'
OUT = HERE.parent.parent / 'app' / 'src' / 'lib' / 'notify' / 'brand-assets.ts'

# (源 webp, 常量名, cid, 渲染 CSS 宽度px)  ——源档是渲染宽的 2 倍，为 retina 留量
JOBS = [
    ('mark-96.webp', 'LOGO_PNG_BASE64', 'tubashu-logo', 48),
    ('pose-guard-160.webp', 'MASCOT_PNG_BASE64', 'tubashu-mascot', 80),
]

WHITE = (255, 255, 255, 255)


def encode(path: pathlib.Path) -> tuple[str, int]:
    im = Image.open(path).convert('RGBA')
    bg = Image.new('RGBA', im.size, WHITE)
    bg.alpha_composite(im)
    q = bg.convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=64)
    b = io.BytesIO()
    q.save(b, 'PNG', optimize=True)
    raw = b.getvalue()
    return base64.b64encode(raw).decode('ascii'), len(raw)


def wrap(b64: str, width: int = 96) -> str:
    return '\n'.join(f"  '{b64[i:i + width]}' +" for i in range(0, len(b64), width)).rstrip(' +')


def main() -> int:
    if not SRC.is_dir():
        print(f'找不到品牌素材目录：{SRC}', file=sys.stderr)
        return 1

    parts = [
        '// app/src/lib/notify/brand-assets.ts',
        '//',
        '// 【本文件由 scripts/brand/make-email-assets.py 生成，不要手改】',
        '// 换素材时重跑该脚本；它同时解释了为什么邮件用 PNG 而不是站内那几张 webp、',
        '// 以及为什么字节码编进模块而不是运行时读 public/。',
        '',
        "import { Buffer } from 'node:buffer';",
        '',
    ]
    meta = []
    for src_name, const, cid, css_px in JOBS:
        path = SRC / src_name
        if not path.is_file():
            print(f'缺素材：{path}', file=sys.stderr)
            return 1
        b64, nbytes = encode(path)
        parts += [
            f'/** {src_name} → 64 色 PNG（{nbytes} 字节），邮件里按 {css_px}px 宽渲染 */',
            f'const {const} =',
            wrap(b64) + ';',
            '',
        ]
        meta.append((const, cid, css_px, src_name, nbytes))
        print(f'{src_name} → {const}  {nbytes} 字节  base64 {len(b64)} 字符')

    parts += [
        '/** 一张随信内嵌的图（cid: 内联附件，不是外链——外链会把平台域名写进邮件） */',
        'export interface BrandAsset {',
        '  /** MIME 部件文件名。**刻意取中性名**：附件名在收件箱里是露出来的。 */',
        '  filename: string;',
        '  /** html 里用 `cid:<cid>` 引用 */',
        '  cid: string;',
        '  contentType: string;',
        '  content: Buffer;',
        '  /** 渲染宽度 px（源档是它的 2 倍，为 retina 留量） */',
        '  widthPx: number;',
        '}',
        '',
    ]
    for const, cid, css_px, src_name, _n in meta:
        name = 'LOGO' if 'LOGO' in const else 'MASCOT'
        fname = 'logo.png' if name == 'LOGO' else 'mascot.png'
        parts += [
            f'/** 品牌头的小标（源 {src_name}） */'
            if name == 'LOGO'
            else f'/** 落款处的吉祥物配图（源 {src_name}） */',
            f'export const {name}: BrandAsset = {{',
            f"  filename: '{fname}',",
            f"  cid: '{cid}',",
            "  contentType: 'image/png',",
            f"  content: Buffer.from({const}, 'base64'),",
            f'  widthPx: {css_px},',
            '};',
            '',
        ]

    OUT.write_text('\n'.join(parts), encoding='utf-8')
    print(f'→ {OUT}  ({OUT.stat().st_size} 字节)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
