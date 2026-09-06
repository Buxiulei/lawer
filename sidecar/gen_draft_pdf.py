#!/usr/bin/env python3
"""
文书 PDF 生成器（reportlab Platypus，markdown 正文 → 分页 PDF，中文字体）

一份草稿（drafts 一行）出一份可打印、可发出的 PDF：标题 + 正文 + 页脚页码。

供 sidecar 内 import 调用：build_draft_pdf(payload: dict, output_path: str) -> str
payload: {"title": str, "markdown": str, "subtitle": str | None, "footer_note": str | None}

【字体解析复用 gen_evidence_pdf.register_font，不另写一份】
中文字体找不到时 reportlab 会静默回落 Helvetica，整篇中文渲成黑块——而这种失败在本机
与生产都复现不出来（取决于装了哪个字体包）。那边已经把「固定清单 + /usr/share/fonts 递归搜」
调对过一次，这里再写一份的形态是：某天有人给那边补了一个路径，这边没补，
于是同一台机器上存证证明是中文的、文书导出是黑块。

【为什么是自己解析 markdown，不引 markdown 库】正文里真正会出现的记号只有这几种
（标题、列表、分隔线、加粗、空行分段），而引一个 markdown → HTML 库之后还要再写一层
HTML → Platypus 的转换，反而多一层会出错的地方。不认识的记号一律**原样按正文排**，
绝不吞字：一份要发给对方的文书，宁可多一个 `#` 号，也不能少一句话。
"""

import json
import re
import sys

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable

from gen_evidence_pdf import register_font, esc

DOC_TITLE = "文书"


def build_styles(font: str):
    styles = getSampleStyleSheet()
    base = ParagraphStyle(
        "dcn", parent=styles["Normal"], fontName=font, fontSize=10.5, leading=19,
        alignment=TA_LEFT, wordWrap="CJK", firstLineIndent=0,
    )
    return {
        "title": ParagraphStyle("dTitle", parent=base, fontSize=17, leading=26,
                                alignment=TA_CENTER, spaceAfter=4),
        "subtitle": ParagraphStyle("dSub", parent=base, fontSize=9.5, leading=15,
                                   alignment=TA_CENTER, textColor=colors.HexColor("#555555")),
        "h1": ParagraphStyle("dH1", parent=base, fontSize=14, leading=22,
                             spaceBefore=12, spaceAfter=5),
        "h2": ParagraphStyle("dH2", parent=base, fontSize=12.5, leading=20,
                             spaceBefore=10, spaceAfter=4),
        "h3": ParagraphStyle("dH3", parent=base, fontSize=11, leading=18,
                             spaceBefore=8, spaceAfter=3),
        "body": base,
        "list": ParagraphStyle("dList", parent=base, leftIndent=14, bulletIndent=4),
        "note": ParagraphStyle("dNote", parent=base, fontSize=8.5, leading=14,
                               textColor=colors.HexColor("#555555")),
    }


_BOLD = re.compile(r"\*\*(.+?)\*\*", re.S)
_HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
_ORDERED = re.compile(r"^\s*(\d{1,3})[.、)]\s+(.*)$")
_RULE = re.compile(r"^\s*([-*_─—]{3,})\s*$")


def inline(text: str) -> str:
    """行内标记 → reportlab 的富文本片段。**先转义再上标记**，顺序反过来就等于开了注入口子。"""
    return _BOLD.sub(r"<b>\1</b>", esc(text))


def build_story(payload: dict, styles) -> list:
    """markdown 正文 → flowable 列表。逐行状态机，不认识的行按正文排。"""
    story = []
    title = (payload.get("title") or "").strip()
    if title:
        story.append(Paragraph(inline(title), styles["title"]))
    subtitle = (payload.get("subtitle") or "").strip()
    if subtitle:
        story.append(Paragraph(inline(subtitle), styles["subtitle"]))
    if title or subtitle:
        story.append(Spacer(1, 6))
        story.append(HRFlowable(width="100%", thickness=0.6,
                                color=colors.HexColor("#cbd5e1"), spaceAfter=8))

    for raw in (payload.get("markdown") or "").replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            story.append(Spacer(1, 5))
            continue

        m = _RULE.match(line)
        if m:
            story.append(HRFlowable(width="100%", thickness=0.5,
                                    color=colors.HexColor("#d1d5db"),
                                    spaceBefore=6, spaceAfter=6))
            continue

        m = _HEADING.match(line)
        if m:
            story.append(Paragraph(inline(m.group(2)), styles[f"h{len(m.group(1))}"]))
            continue

        m = _BULLET.match(line)
        if m:
            story.append(Paragraph(inline(m.group(1)), styles["list"], bulletText="·"))
            continue

        m = _ORDERED.match(line)
        if m:
            story.append(Paragraph(inline(m.group(2)), styles["list"],
                                   bulletText=f"{m.group(1)}."))
            continue

        story.append(Paragraph(inline(line), styles["body"]))

    note = (payload.get("footer_note") or "").strip()
    if note:
        story.append(Spacer(1, 10))
        story.append(HRFlowable(width="100%", thickness=0.5,
                                color=colors.HexColor("#d1d5db"), spaceAfter=6))
        story.append(Paragraph(inline(note), styles["note"]))
    return story


def build_draft_pdf(payload: dict, output_path: str) -> str:
    """渲染一份文书 PDF 到 output_path，返回该路径。

    正文为空直接抛 ValueError：一份零字的 PDF 看起来像导出成功了，
    用户要到打开它的时候才发现——而那时他多半已经把它发出去了。
    """
    if not (payload.get("markdown") or "").strip():
        raise ValueError("缺少正文（markdown）")

    font = register_font()
    styles = build_styles(font)
    story = build_story(payload, styles)
    title = (payload.get("title") or DOC_TITLE).strip()

    def _footer(canvas, doc):
        canvas.saveState()
        canvas.setFont(font, 7.5)
        canvas.setFillColor(colors.HexColor("#999999"))
        canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f"第 {doc.page} 页")
        canvas.drawString(18 * mm, 12 * mm, title[:40])
        canvas.restoreState()

    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=20 * mm, bottomMargin=20 * mm,
        title=title,
    )
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return output_path


def main():
    if len(sys.argv) < 3:
        print("用法: gen_draft_pdf.py <payload.json> <output.pdf>", file=sys.stderr)
        sys.exit(2)
    payload_path, output_path = sys.argv[1], sys.argv[2]
    try:
        with open(payload_path, "r", encoding="utf-8") as f:
            p = json.load(f)
        build_draft_pdf(p, output_path)
    except Exception as e:  # noqa: BLE001 —— CLI 边界，原因原样吐给调用方
        print(f"ERR:{type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"OK:{output_path}")


if __name__ == "__main__":
    main()
