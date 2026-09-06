"""/draft-pdf 与 gen_draft_pdf 的判据（全离线，不打外部网络）。

运行: .venv/bin/python -m pytest tests/test_draft_pdf.py -q

【为什么用 pypdf 抽文本，不在 PDF 字节里 grep 中文】reportlab 把中文写成 TTF 子集里的
字形号，源码里那几个字在 PDF 字节流里根本搜不到。不解 ToUnicode 就断言"字节里有这几个字"
的测试，在**中文渲染成黑块**时照样绿——那正是这条判据要拦的失败。
"""

import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gen_draft_pdf  # noqa: E402
import main  # noqa: E402

pypdf = pytest.importorskip("pypdf")

client = TestClient(main.app)

BODY = """# 解除劳动合同的异议

致：某某科技有限公司

本人于【入职日期】入职贵司，担任【岗位】。现就贵司于【日期】作出的解除决定提出异议：

1. 解除通知未列明具体事实与依据。
2. 未与工会沟通。

- 附件一：解除通知书照片
- 附件二：工资流水

**请贵司于收到本函之日起七日内书面回复。**

---

此致
"""


def _text_of(pdf_bytes: bytes) -> str:
    reader = pypdf.PdfReader(__import__("io").BytesIO(pdf_bytes))
    return "".join(page.extract_text() or "" for page in reader.pages)


def test_draft_pdf_contains_chinese_body():
    """正文里的中文必须能从 PDF 里原样抽回来（变异：把字体解析换成 Helvetica ⇒ 抽不到 ⇒ 红）。"""
    res = client.post("/draft-pdf", json={"title": "关于解除决定的异议函", "markdown": BODY})
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "application/pdf"
    assert res.content.startswith(b"%PDF")

    text = _text_of(res.content)
    # 标题、正文段落、有序列表、无序列表、加粗行 —— 五种记号各取一句
    for expected in [
        "关于解除决定的异议函",
        "解除劳动合同的异议",
        "某某科技有限公司",
        "解除通知未列明具体事实与依据",
        "附件一：解除通知书照片",
        "请贵司于收到本函之日起七日内书面回复",
    ]:
        assert expected in text, f"PDF 正文里没抽到「{expected}」；抽到的是：{text[:400]!r}"


def test_markdown_marks_are_stripped_not_the_words():
    """记号本身不入正文，但记号后面的字一个都不能少（不认识的记号原样排，绝不吞字）。"""
    res = client.post(
        "/draft-pdf",
        json={"title": "标题", "markdown": "## 二级标题\n> 这是一句引用记号开头的话\n普通一行"},
    )
    assert res.status_code == 200
    text = _text_of(res.content)
    assert "二级标题" in text
    assert "## " not in text
    # '>' 不是本文件认识的记号 —— 整行原样排出来，一个字不吞
    assert "这是一句引用记号开头的话" in text
    assert "普通一行" in text


def test_empty_body_is_rejected_not_rendered_blank():
    """空正文 400，不生成一份看起来成功、打开是空白的 PDF。"""
    res = client.post("/draft-pdf", json={"title": "只有标题", "markdown": "   \n  "})
    assert res.status_code == 400
    assert "正文" in res.json()["detail"]


def test_build_draft_pdf_raises_on_empty_body(tmp_path):
    with pytest.raises(ValueError):
        gen_draft_pdf.build_draft_pdf({"title": "x", "markdown": ""}, str(tmp_path / "o.pdf"))


def test_font_resolution_is_shared_with_evidence_pdf():
    """字体解析必须是 gen_evidence_pdf 那一份，不是另抄的一份。

    两份的形态是：某天有人给存证那边补了一个字体路径，这边没补，
    于是同一台机器上存证证明是中文的、文书导出是黑块。
    """
    import gen_evidence_pdf

    assert gen_draft_pdf.register_font is gen_evidence_pdf.register_font
