#!/usr/bin/env python3
"""
《存证证明》PDF 生成器（reportlab Platypus，自动分页，中文字体）

一份存证订单（attestations 一行）出一份证明：持证人实名快照 + 证据标的元信息 +
文件 SHA-256 + RFC3161 可信时间戳（genTime / serial / TSA）+ 独立验证方法 + 效力声明。
TST 原文以 base64 附录随文分发，使本 PDF 自带离线复核所需的全部材料。

供 sidecar 内 import 调用：build_evidence_pdf(payload: dict, output_path: str) -> str
亦保留 CLI:
  python3 gen_evidence_pdf.py <payload.json> <output.pdf>
  输出: OK:<output.pdf>   （成功，stdout）
        ERR:<message>     （失败，stderr + exit 1）

生成的是「未签名」base PDF；上层随后调用 pades_sign.py 施加 PAdES-B-LT 数字签名，
使 Adobe Acrobat/Reader 能识别整份文档的完整性与可信时间戳。

payload 结构见 build_story 各 build_* 函数（字段名对齐 spec §7 attestations / evidence / files）。
"""

import json
import sys
from pathlib import Path

# reportlab
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, HRFlowable, PageBreak, KeepTogether,
)


# ---- 中文字体注册（优先级顺序，subfontIndex=0）----
FONT_PATHS = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
]

DOC_TITLE = "证据存证证明"


def register_font() -> str:
    for fp in FONT_PATHS:
        if Path(fp).exists():
            try:
                pdfmetrics.registerFont(TTFont("CJK", fp, subfontIndex=0))
                return "CJK"
            except Exception:
                continue
    return "Helvetica"


def esc(v) -> str:
    """转义 reportlab Paragraph 的 XML 标记字符，None/空转空串。"""
    if v is None:
        return ""
    s = str(v)
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def tsa_label(status, tsa_time) -> str:
    """三态可信时间戳文案（对应 attestations.status）。"""
    if status == "stamped":
        return f"{esc(tsa_time)}（RFC3161 可信时间戳）" if tsa_time else "已加盖可信时间戳"
    if status == "pending":
        return "待盖章 · 仅本地哈希留痕"
    if status == "failed":
        return "时间戳暂不可用 · 不影响文件哈希留痕"
    return "系统记录时间 · 非可信盖章"


def build_styles(font: str):
    styles = getSampleStyleSheet()
    base = ParagraphStyle(
        "cn", parent=styles["Normal"], fontName=font, fontSize=9.5, leading=15,
        alignment=TA_LEFT, wordWrap="CJK",
    )
    return {
        "title": ParagraphStyle("cnTitle", parent=base, fontSize=18, leading=26,
                                 alignment=TA_CENTER, spaceAfter=6),
        "subtitle": ParagraphStyle("cnSub", parent=base, fontSize=10, leading=16,
                                    alignment=TA_CENTER, textColor=colors.HexColor("#555555")),
        "h2": ParagraphStyle("cnH2", parent=base, fontSize=12.5, leading=20,
                              spaceBefore=10, spaceAfter=4, textColor=colors.HexColor("#1f2a44")),
        "h3": ParagraphStyle("cnH3", parent=base, fontSize=10.5, leading=17,
                             spaceBefore=6, spaceAfter=2, textColor=colors.HexColor("#374151")),
        "body": base,
        "meta": ParagraphStyle("cnMeta", parent=base, fontSize=9, leading=14,
                               textColor=colors.HexColor("#333333")),
        # 沿用中文字体：曾硬编码 Helvetica（无 CJK 字形），中文标签整片渲染成黑块
        "mono": ParagraphStyle("cnMono", parent=base, fontSize=8.5,
                               leading=13, textColor=colors.HexColor("#444444")),
        "sig": ParagraphStyle("cnSig", parent=base, fontSize=9, leading=14,
                              textColor=colors.HexColor("#111111")),
        "warn": ParagraphStyle("cnWarn", parent=base, fontSize=9.5, leading=15,
                              textColor=colors.HexColor("#b91c1c")),
        "note": ParagraphStyle("cnNote", parent=base, fontSize=8.5, leading=14,
                               textColor=colors.HexColor("#555555")),
        # TST base64 附录：定宽换行，字号压到能放下整块
        "b64": ParagraphStyle("cnB64", parent=base, fontSize=6.5, leading=8.5,
                              textColor=colors.HexColor("#333333")),
    }


def kv(style, label, value):
    """一行「标签：值」段落（值转义）。"""
    return Paragraph(f"<b>{esc(label)}</b>：{esc(value)}", style)


def rule():
    return HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#cbd5e1"),
                      spaceBefore=4, spaceAfter=4)


def wrap_b64(s: str, width: int = 100) -> str:
    """把无空格的 base64 切成定长行（reportlab 不会在无分隔符处断行）。"""
    s = (s or "").strip()
    return "<br/>".join(s[i:i + width] for i in range(0, len(s), width))


def human_size(n) -> str:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "—"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def build_header(p, styles):
    """封面抬头：出证方、订单号、出证时间。"""
    return [
        Paragraph(DOC_TITLE, styles["title"]),
        Paragraph("Evidence Attestation Certificate", styles["subtitle"]),
        Spacer(1, 10),
        rule(),
        kv(styles["meta"], "存证订单号", p.get("order_no", "")),
        kv(styles["meta"], "出证平台", p["issuer"]),
        kv(styles["meta"], "出证时间", p.get("generated_at", "")),
        kv(styles["meta"], "验证入口", p.get("verify_url", "")),
        rule(),
        Spacer(1, 6),
        Paragraph(
            "本证明记载：下列电子数据文件于所载可信时间戳时刻之前已经存在，且其内容自该时刻起"
            "未被改动。文件哈希、时间戳令牌与验证方法一并载于本文件，任何第三方均可独立复核，"
            "无需依赖出证平台。",
            styles["body"],
        ),
        Spacer(1, 4),
    ]


def build_holder(p, styles):
    """一、持证人（实名快照，由上层解密后传入）。"""
    h = p.get("holder", {})
    block = [
        Paragraph("一、持证人", styles["h2"]),
        kv(styles["meta"], "姓名", h.get("real_name") or "—"),
        kv(styles["meta"], "证件号", h.get("id_card_masked") or "—"),
        kv(styles["meta"], "实名状态", h.get("auth_status") or "未认证"),
        kv(styles["meta"], "实名核验时间", h.get("verified_at") or "—"),
    ]
    if (h.get("auth_status") or "") != "已实名":
        block.append(Paragraph(
            "⚠ 持证人未完成实人认证：本证明仅能证明「该文件在时间戳时刻已存在且此后未改动」，"
            "不能证明上传者身份。",
            styles["warn"]))
    block.append(Spacer(1, 4))
    return block


def build_evidence(p, styles):
    """二、证据标的（evidence + files 元信息与文件哈希）。"""
    e = p.get("evidence", {})
    sha = (e.get("sha256") or "").lower()
    block = [
        Paragraph("二、证据标的", styles["h2"]),
        kv(styles["meta"], "关联案件", e.get("case_title") or "—"),
        kv(styles["meta"], "证据名称", e.get("name") or "—"),
        kv(styles["meta"], "证据类别", e.get("category") or "—"),
        kv(styles["meta"], "证明目的", e.get("prove_purpose") or "—"),
        kv(styles["meta"], "原始载体", e.get("original_medium") or "—"),
        kv(styles["meta"], "文件类型", e.get("mime") or "—"),
        kv(styles["meta"], "文件大小", human_size(e.get("file_size"))),
        kv(styles["meta"], "上传时间", e.get("uploaded_at") or "—"),
        Spacer(1, 3),
        Paragraph("文件内容指纹（SHA-256，全文）", styles["h3"]),
        Paragraph(f"<b>{esc(sha)}</b>", styles["mono"]),
        Spacer(1, 4),
    ]
    return block


def build_timestamp(p, styles):
    """三、可信时间戳。"""
    t = p.get("timestamp", {})
    status = p.get("status") or ("stamped" if t.get("gen_time") else "pending")
    block = [
        Paragraph("三、可信时间戳（RFC 3161）", styles["h2"]),
        Paragraph(f"<b>盖章状态</b>：{tsa_label(status, t.get('gen_time'))}", styles["sig"]),
        kv(styles["sig"], "时间戳时刻(genTime)", t.get("gen_time") or "—"),
        kv(styles["sig"], "令牌序列号(serialNumber)", t.get("serial") or "—"),
        kv(styles["sig"], "时间戳服务(TSA)", t.get("tsa_url") or "—"),
        kv(styles["sig"], "摘要算法", "SHA-256"),
        Paragraph(
            "时间戳令牌由第三方 TSA 以其私钥签发，签发私钥不在出证平台手中，出证平台无法伪造或"
            "回溯改写该时刻。令牌内的 messageImprint 即上节 SHA-256，二者必须一致方为有效。",
            styles["note"]),
        Spacer(1, 4),
    ]
    return block


def build_howto(p, styles):
    """四、如何独立验证（三步，任何第三方可离线复现）。"""
    return [
        Paragraph("四、如何独立验证本证明", styles["h2"]),
        Paragraph("第 1 步：复算原始文件哈希", styles["h3"]),
        Paragraph(
            "对持有的原始证据文件执行 <b>sha256sum &lt;文件&gt;</b>（Windows 用 "
            "<b>certutil -hashfile &lt;文件&gt; SHA256</b>），结果应与第二节所载 64 位指纹逐字相同。"
            "不同即文件已被改动或非同一份文件。",
            styles["body"]),
        Paragraph("第 2 步：验证时间戳令牌", styles["h3"]),
        Paragraph(
            "将文末附录的 TST（base64）解码存为 token.tsr，用 OpenSSL 离线校验："
            "<b>openssl ts -reply -in token.tsr -text</b> 查看 genTime 与 messageImprint；"
            "并以 TSA 的 CA 证书验签：<b>openssl ts -verify -digest &lt;上节SHA256&gt; "
            "-in token.tsr -CAfile &lt;TSA_CA.pem&gt;</b>。校验通过即证明该哈希在 genTime 之前已存在。",
            styles["body"]),
        Paragraph("第 3 步：验证本 PDF 自身未被篡改", styles["h3"]),
        Paragraph(
            "用 Adobe Acrobat / Reader 打开本文件 → 打开「签名面板」：应显示「已签名，且自签署以来"
            "文档未被更改」。亦可用本平台开源的 <b>verify_evidence_pdf.py</b> 做独立密码学验签"
            "（PAdES 签名完整性 + 证书链锚定 + 时间戳链锚定，全离线）。",
            styles["body"]),
        Spacer(1, 4),
    ]


def build_tail(p, styles):
    """五、效力与局限声明 + TST 附录。"""
    signer_entity = p.get("signer_entity")
    story = [
        Paragraph("五、效力与局限声明", styles["h2"]),
        Paragraph(
            "① 本证明证明的是「<b>该文件在时间戳时刻之前已经存在、且此后未被篡改</b>」，"
            "<b>不证明文件内容本身属实</b>，也不证明文件的来源、取得方式合法。内容真实性与"
            "证明力由办案机关依法认定。",
            styles["note"]),
        Paragraph(
            "② 单方申请的 RFC3161 可信时间戳属有力辅助证据（可命中《最高人民法院关于民事诉讼证据的"
            "若干规定》第九十四条电子数据推定真实的情形），但<b>非公证书、非鉴定意见</b>，"
            "对方仍可举证反驳。本证明不作「绝对不可抵赖」等夸大表述。",
            styles["note"]),
        Paragraph(
            "③ 原始文件请自行妥善留存：本证明只锁定哈希，不含文件内容本身；丢失原件将无法据本证明"
            "还原或比对。建议同时保留原始载体（手机、邮箱、聊天记录导出件等）。",
            styles["note"]),
    ]
    if signer_entity:
        story.append(Paragraph(
            f"④ 本 PDF 由 <b>{esc(signer_entity)}</b> 持有的机构实名证书施加 PAdES-B-LT 数字签名。"
            "该证书由经国家许可的第三方电子认证服务机构签发，依《中华人民共和国电子签名法》具备法律效力。"
            "若 Adobe 首次打开显示「签署者身份未知」，属信任列表同步延迟，待其后台更新后即显示受信任，"
            "<b>不代表签名无效或文档被篡改</b>；文档完整性与可信时间戳始终可离线校验、与信任列表无关。",
            styles["note"]))

    tst_b64 = (p.get("timestamp", {}) or {}).get("tst_b64")
    if tst_b64:
        story += [
            PageBreak(),
            Paragraph("附录：时间戳令牌原文（TST, base64 DER）", styles["h2"]),
            Paragraph(
                "以下为 RFC3161 TimeStampToken 的完整 DER 编码 base64 文本，供第 2 步离线校验使用。"
                "解码命令：<b>base64 -d &lt; token.b64 &gt; token.tsr</b>",
                styles["note"]),
            Spacer(1, 4),
            Paragraph(wrap_b64(esc(tst_b64)), styles["b64"]),
        ]
    return story


def build_story(p, styles):
    story = []
    story += build_header(p, styles)
    story.append(KeepTogether(build_holder(p, styles)))
    story.append(rule())
    story += build_evidence(p, styles)
    story.append(rule())
    story.append(KeepTogether(build_timestamp(p, styles)))
    story.append(rule())
    story += build_howto(p, styles)
    story.append(rule())
    story += build_tail(p, styles)
    return story


# 必填字段：缺任何一个都**拒绝生成**，不兜底、不留空。
#
# 【为什么 issuer 不许有默认值（2026-08-27）】原实现是
# `p.get("issuer", "lawer 裁员应对专员")` —— **一个写死的兜底品牌名**。
# 三条理由，每条单独都够：
#  ① **它回答的是"这张证是谁出的"**，而这份 PDF 用户可能拿去仲裁庭。
#     兜底不是"少显示一点信息"，是**替调用方编了一个答案**，而且编得像真的。
#  ② 本模块**早就有必填契约**（order_no / evidence.sha256 缺则 400，且有测试），
#     issuer 静默兜底与模块自己的设计不一致。
#  ③ 唯一的调用方 `app/src/lib/evidence/attest.ts` **无条件**传这个字段。
#     ⇒ 它缺失只可能意味着调用方坏了或来了个我们不知道的调用路径——
#     **那正是最需要报出来的时刻，而不是最需要糊过去的时刻。**
#
# 【为什么守在这里而不只守在 main.py】`build_evidence_pdf` 是可被直接 import 的公开入口
#（模块 docstring 里就写着 CLI 用法）。**只守在 HTTP 层，等于让这条保证依赖"调用方走了哪条路"。**
REQUIRED_TOP_LEVEL = ("order_no", "issuer")


def build_evidence_pdf(payload: dict, output_path: str) -> str:
    """按 payload 渲染《存证证明》PDF 到 output_path，返回该路径。

    缺必填字段直接抛 ValueError —— 宁可不出证，也不出一份把出证方写错的证。
    """
    missing = [k for k in REQUIRED_TOP_LEVEL if not (payload.get(k) or "").strip()]
    if not ((payload.get("evidence") or {}).get("sha256") or "").strip():
        missing.append("evidence.sha256")
    if missing:
        raise ValueError(f"缺少必填字段：{'、'.join(missing)}")

    font = register_font()
    styles = build_styles(font)
    story = build_story(payload, styles)

    order_no = payload.get("order_no", "")

    def _footer(canvas, doc):
        canvas.saveState()
        canvas.setFont(font, 7.5)
        canvas.setFillColor(colors.HexColor("#999999"))
        canvas.drawRightString(A4[0] - 18 * mm, 12 * mm, f"第 {doc.page} 页")
        canvas.drawString(18 * mm, 12 * mm, f"{DOC_TITLE} · 订单号 {order_no}")
        canvas.restoreState()

    doc = SimpleDocTemplate(
        output_path, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=18 * mm, bottomMargin=20 * mm,
        title=f"{DOC_TITLE} {order_no}".strip(),
    )
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return output_path


def main():
    if len(sys.argv) < 3:
        print("用法: gen_evidence_pdf.py <payload.json> <output.pdf>", file=sys.stderr)
        sys.exit(2)
    payload_path, output_path = sys.argv[1], sys.argv[2]
    try:
        with open(payload_path, "r", encoding="utf-8") as f:
            p = json.load(f)
        build_evidence_pdf(p, output_path)
        print(f"OK:{output_path}")
    except Exception as e:
        import traceback
        print(f"ERR:{e}\n{traceback.format_exc()}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
