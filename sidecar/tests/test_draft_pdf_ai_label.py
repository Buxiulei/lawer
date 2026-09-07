"""导出的文书 PDF 必须带两种生成合成内容标识（全离线，不打外部网络）。

依据（官方原件 https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm，
source_id: statute-ai-shengcheng-hecheng-neirong-biaoshi-banfa）：
《人工智能生成合成内容标识办法》
  · 第四条末款：「服务提供者提供生成合成内容下载、复制、导出等功能时，
    应当确保文件中含有满足要求的显式标识。」
  · 第五条：「…在生成合成内容的文件元数据中添加隐式标识，隐式标识包含生成合成内容属性信息、
    服务提供者名称或者编码、内容编号等制作要素信息。」

运行: .venv/bin/python -m pytest tests/test_draft_pdf_ai_label.py -q

【为什么显式那一半要用 pypdf 抽文本，不在字节里 grep】同 test_draft_pdf 的理由：
reportlab 把中文写成字形号，源码里那几个字在 PDF 字节流里搜不到；不解 ToUnicode 的断言
在**中文渲成黑块**时照样绿——而一份印着黑块的标识等于没有标识。

【为什么隐式那一半要读回来，不看调用参数】"传给了 reportlab"与"写进了文件"是两件事：
键名拼错、reportlab 换版不再认某个键，两种都不报错，PDF 照常生成。
"""

import io
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gen_draft_pdf  # noqa: E402
import main  # noqa: E402

pypdf = pytest.importorskip("pypdf")

client = TestClient(main.app)

LABEL = "以下内容由人工智能生成合成，不构成律师意见，不形成委托代理关系。"
AI_META = {
    "producer": "北京天开艾洛迪心理咨询有限公司（土八鼠）",
    "subject": "AI生成合成内容｜《人工智能生成合成内容标识办法》第五条",
    "keywords": "AI生成合成内容;服务提供者=北京天开艾洛迪心理咨询有限公司（土八鼠）;内容编号=draft:7@v2",
}
PAYLOAD = {
    "title": "关于解除决定的异议函",
    "markdown": "正文第一段。\n\n正文第二段。",
    "ai_label": LABEL,
    "ai_meta": AI_META,
}


def _render(payload: dict) -> bytes:
    res = client.post("/draft-pdf", json=payload)
    assert res.status_code == 200, res.text
    assert res.content.startswith(b"%PDF")
    return res.content


def _text_of(pdf_bytes: bytes) -> str:
    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    return "".join(page.extract_text() or "" for page in reader.pages)


def _meta_of(pdf_bytes: bytes) -> dict:
    return dict(pypdf.PdfReader(io.BytesIO(pdf_bytes)).metadata or {})


# ───────────────── 显式标识（§4 末款） ─────────────────


def test_explicit_label_is_in_the_file():
    """整句逐字印在纸上（变异：把 build_story 里那三行 ai_label 删掉 ⇒ 红）。"""
    text = _text_of(_render(PAYLOAD))
    assert "正文第一段。" in text, "正文都没抽出来，下面在验空字符串"
    assert LABEL in text


def test_explicit_label_precedes_the_body():
    """标识排在正文**之前**（§4 第（一）项「在文本的起始…」）。

    排在末尾也合法，但一份文书常常只有第一页被看；排在后面的形态是：
    读的人一路读到底才知道这是 AI 写的，而多数人读到一半就照着发出去了。
    变异：把那三行挪到 build_story 末尾 ⇒ 红。
    """
    text = _text_of(_render(PAYLOAD))
    assert text.index(LABEL) < text.index("正文第一段。")


def test_no_label_given_means_no_label_invented():
    """调用方不给就不印——本模块不替它编一句（变异：给 ai_label 兜个默认值 ⇒ 红）。"""
    text = _text_of(_render({"title": "无标识件", "markdown": "正文。"}))
    assert "人工智能" not in text


# ───────────────── 隐式标识（§5） ─────────────────


def test_implicit_label_three_elements_land_in_metadata():
    """三要素都能从文件元数据里读回来（变异：删掉 SimpleDocTemplate 的 **doc_meta ⇒ 红）。"""
    meta = _meta_of(_render(PAYLOAD))
    # 服务提供者名称
    assert meta.get("/Producer") == AI_META["producer"]
    # 生成合成内容属性信息
    assert "AI生成合成内容" in (meta.get("/Subject") or "")
    # 内容编号
    assert "内容编号=draft:7@v2" in (meta.get("/Keywords") or "")


def test_metadata_survives_without_ai_meta():
    """不给 ai_meta 时照常出 PDF，只是没有隐式标识——不抛、也不写一份编的。

    兜一份写死的服务提供者名称的形态是：某个不是我们生成的文件被盖上我们的名字，
    而办法 §10 明文禁止伪造标识。
    """
    meta = _meta_of(_render({"title": "无标识件", "markdown": "正文。"}))
    assert meta.get("/Producer") != AI_META["producer"]


def test_partial_ai_meta_writes_only_what_was_given():
    """给了哪几项就写哪几项，缺的不兜（变异：给缺项填默认值 ⇒ 红）。"""
    meta = _meta_of(
        _render({**PAYLOAD, "ai_meta": {"producer": AI_META["producer"], "subject": "", "keywords": None}})
    )
    assert meta.get("/Producer") == AI_META["producer"]
    assert not (meta.get("/Keywords") or "")


def test_build_draft_pdf_writes_metadata_directly(tmp_path):
    """不经 HTTP 也一样：这条判据钉的是渲染器本身，不是路由。"""
    out = str(tmp_path / "o.pdf")
    gen_draft_pdf.build_draft_pdf(PAYLOAD, out)
    with open(out, "rb") as f:
        meta = _meta_of(f.read())
    assert meta.get("/Producer") == AI_META["producer"]
