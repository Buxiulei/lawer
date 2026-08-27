"""sidecar 端点单测（全离线，不打外部网络）。

运行: .venv/bin/python -m pytest tests -q
"""

import hashlib
import os
import re
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gen_evidence_pdf  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)


def _payload():
    """一份最小但字段齐全的存证元数据。"""
    return {
        "order_no": "LAWER-ATT-20260819-000001",
        "generated_at": "2026-08-19T12:00:00+08:00",
        "issuer": "lawer 土八鼠",
        "verify_url": "https://example.com/verify/LAWER-ATT-20260819-000001",
        "status": "stamped",
        "holder": {
            "real_name": "张三",
            "id_card_masked": "1101**********1234",
            "auth_status": "已实名",
            "verified_at": "2026-08-18T09:00:00+08:00",
        },
        "evidence": {
            "case_title": "与某某公司劳动争议",
            "name": "解除劳动合同通知书.jpg",
            "category": "公司文件",
            "prove_purpose": "证明公司于 2026-08-01 单方解除劳动合同",
            "original_medium": "手机拍照",
            "mime": "image/jpeg",
            "file_size": 234567,
            "uploaded_at": "2026-08-18T10:00:00+08:00",
            "sha256": "a" * 64,
        },
        "timestamp": {
            "gen_time": "2026-08-18T02:00:05+00:00",
            "serial": "123456789012345678",
            "tsa_url": "http://aatl-timestamp.globalsign.com/tsa/x",
            "tst_b64": "TUlJRkFrWUpLb1pJaHZjTkFRY0NvSUlFOXpDQ0JQTUNBUU14",
        },
    }


# ---------------- /tsa 入参校验 ----------------

@pytest.mark.parametrize("bad", [
    "",                    # 空
    "abc",                 # 太短
    "a" * 63,              # 差一位
    "a" * 65,              # 多一位
    "g" * 64,              # 非 hex 字符
    "a" * 32 + "!" * 32,   # 含符号
])
def test_tsa_rejects_bad_hash(bad):
    r = client.post("/tsa", json={"sha256": bad})
    assert r.status_code == 422, r.text


def test_tsa_rejects_missing_hash():
    assert client.post("/tsa", json={}).status_code == 422


def test_tsa_rejects_out_of_range_timeout():
    r = client.post("/tsa", json={"sha256": "a" * 64, "timeout": 0})
    assert r.status_code == 422


def test_tsa_accepts_valid_hash_and_returns_token(monkeypatch):
    """合法哈希放行到下游；下游打桩，不真打 TSA。"""
    captured = {}

    def fake(hex_hash, tsa_url, timeout):
        captured.update(hex_hash=hex_hash, tsa_url=tsa_url, timeout=timeout)
        return {"tst_b64": "AAAA", "gen_time": "2026-08-19T00:00:00+00:00",
                "serial": "42", "tsa_url": tsa_url}

    monkeypatch.setattr(main, "request_timestamp", fake)
    r = client.post("/tsa", json={"sha256": "A" * 64, "tsa_url": "http://tsa.example/x"})
    assert r.status_code == 200
    assert r.json()["serial"] == "42"
    assert captured["tsa_url"] == "http://tsa.example/x"


def test_tsa_upstream_failure_is_502(monkeypatch):
    def boom(hex_hash, tsa_url, timeout):
        raise main.TimestampError("TSA 请求失败")

    monkeypatch.setattr(main, "request_timestamp", boom)
    r = client.post("/tsa", json={"sha256": "a" * 64})
    assert r.status_code == 502


# ---------------- /evidence-pdf → /verify 回环 ----------------

def test_evidence_pdf_generates_parseable_pdf():
    r = client.post("/evidence-pdf", json=_payload())
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF-")
    assert len(r.content) > 2000  # 不是空壳


@pytest.mark.parametrize("missing", ["order_no", "evidence", "issuer"])
def test_evidence_pdf_rejects_incomplete_payload(missing):
    p = _payload()
    del p[missing]
    assert client.post("/evidence-pdf", json=p).status_code == 400


@pytest.mark.parametrize("missing", ["order_no", "issuer", "evidence"])
def test_build_evidence_pdf_itself_refuses_incomplete(missing, tmp_path):
    """**直接 import 的那条路也要守住**，不能只守 HTTP 层。

    【为什么单独有这一条 —— 变异实测出来的】把生成器内部那道守撤掉、
    把 `p.get("issuer", "<写死的品牌名>")` 兜底放回去，**上面那条 HTTP 测试照样全绿**：
    它只走 `/evidence-pdf`，而 `build_evidence_pdf` 是模块 docstring 里就写明的公开入口
    （还有 CLI 用法）。
    ⇒ **只测 HTTP 层，等于让这条保证依赖"调用方走了哪条路"，而测试完全看不出来。**
    """
    p = _payload()
    del p[missing]
    with pytest.raises(ValueError, match="缺少必填字段"):
        gen_evidence_pdf.build_evidence_pdf(p, str(tmp_path / "x.pdf"))


def test_gen_then_verify_refuses_unsigned_pdf():
    """回环的离线部分：生成的 base PDF 尚未签名，验签必须判不通过。

    「未签名 → overall_ok=False」是本工具的核心安全属性：绝不把「没验」当「通过」。
    """
    pdf = client.post("/evidence-pdf", json=_payload()).content
    r = client.post("/verify", files={"file": ("evidence.pdf", pdf, "application/pdf")})
    assert r.status_code == 200
    v = r.json()
    assert v["overall_ok"] is False
    assert v["num_signatures"] == 0
    assert "无嵌入数字签名" in (v["error"] or "")
    # 未提供 expect_hash 时 hash_match 为 None，且文件哈希如实回报
    assert v["hash_match"] is None
    assert v["file_sha256"] == hashlib.sha256(pdf).hexdigest()


def test_verify_detects_hash_mismatch():
    """换文件场景：expect_hash 与实际不符必须判 False。"""
    pdf = client.post("/evidence-pdf", json=_payload()).content
    r = client.post(
        "/verify",
        files={"file": ("evidence.pdf", pdf, "application/pdf")},
        data={"expect_hash": "b" * 64},
    )
    v = r.json()
    assert v["hash_match"] is False
    assert v["overall_ok"] is False


def test_verify_rejects_empty_upload():
    r = client.post("/verify", files={"file": ("x.pdf", b"", "application/pdf")})
    assert r.status_code == 400


def test_verify_handles_non_pdf():
    r = client.post("/verify", files={"file": ("x.pdf", b"not a pdf", "application/pdf")})
    assert r.status_code == 200
    assert r.json()["overall_ok"] is False


# ---------------- 未配置 key 时的降级 ----------------

def test_ocr_without_key_returns_503(monkeypatch):
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    r = client.post("/ocr", files={"file": ("a.jpg", b"\xff\xd8\xff\xe0fake", "image/jpeg")})
    assert r.status_code == 503
    assert "DASHSCOPE_API_KEY" in r.json()["detail"]


def test_asr_without_key_returns_503(monkeypatch):
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    r = client.post("/asr", files={"file": ("a.wav", b"RIFFfake", "audio/wav")})
    assert r.status_code == 503
    assert "DASHSCOPE_API_KEY" in r.json()["detail"]


def test_pades_without_cert_returns_503(monkeypatch):
    monkeypatch.delenv("SIGNING_CERT_PATH", raising=False)
    pdf = client.post("/evidence-pdf", json=_payload()).content
    r = client.post("/pades", files={"file": ("in.pdf", pdf, "application/pdf")})
    assert r.status_code == 503
    assert "SIGNING_CERT_PATH" in r.json()["detail"]


def test_health():
    assert client.get("/health").json() == {"ok": True}


# ---------------- 模型版本锁定（定价约束） ----------------

def test_ocr_model_is_pinned_to_dated_version():
    """OCR 模型必须锁 dated 版本号。

    浮动别名（-latest / 无后缀）指向变更会把单价从 0.3 元拉到老版的 5 元，差 16 倍，
    且不会有任何报错提示。见 research/raw/C01-模型定价核定.md §二。
    """
    import ocr

    m = ocr.DEFAULT_OCR_MODEL
    assert not m.endswith("-latest"), f"OCR 模型不得用浮动别名: {m}"
    assert re.search(r"-\d{4}-\d{2}-\d{2}$", m), f"OCR 模型须锁 dated 版本号: {m}"
