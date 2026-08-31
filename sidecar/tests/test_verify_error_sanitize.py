"""验签裁决的对外错误分级（SYS-05b）——出口不漏路径，日志不丢原文。

【为什么这条测试存在】verify_evidence_pdf 的 `error` 字段不是内部字段：app 侧
`lib/evidence/recheck.ts` 会把它原样拼进公开复核页的失败理由，而 /verify/:no
是**匿名可访问**的。基线上有五处把裸 `{e}` / `{type(e).__name__}: {e}` 写进去，
其中信任锚那处直接把服务器绝对路径 `_TRUST_ANCHOR_DIR` 送出门。

判据分三层，缺一层就有变异能全绿穿过（见文件末尾的变异核记录）：
  1) 出口无路径 —— 断言的是**整份裁决 JSON 序列化后**不含标记串，
     不是只看 `error` 一个键（否则「换个字段继续漏」照样绿）；
  2) 日志有原文 —— 断言原始异常/明细进了 logger，
     否则「删干净就完事」会让线上彻底失去排障依据，测试却全绿；
  3) 静态安全原因原文保留 + 稳定码 —— 否则「一律换成一句通用兜底」也全绿，
     而那会把「这份文件根本没签名」这种用户必须知道的事实一起抹掉。
"""

import builtins
import io
import json
import logging
import os
import re
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main  # noqa: E402
import verify_evidence_pdf as vep  # noqa: E402

client = TestClient(main.app)

# 冒充「服务器上真实存在、不该外泄」的绝对路径。测试只认这一串：
# 它出现在出口 = 泄露；它出现在日志 = 排障依据还在。
MARKER = "/opt/lawer-internal/srv/.venv/lib/python3.12/site-packages"


@pytest.fixture
def caught(caplog):
    """捕获 sidecar 验签日志（ERROR 级，含 traceback）。"""
    caplog.set_level(logging.ERROR, logger="sidecar.verify_evidence_pdf")
    return caplog


def unsigned_pdf() -> bytes:
    """一份结构合法、但没有任何嵌入签名的 PDF。"""
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(100, 100, "unsigned")
    c.save()
    return buf.getvalue()


def assert_sanitized(verdict: dict, code: str, caught):
    """出口三连：整份 JSON 不含路径、错误码是约定的那个、对外文案是登记过的安全概述。"""
    dumped = json.dumps(verdict, ensure_ascii=False)
    assert MARKER not in dumped, f"服务器路径泄露到对外裁决: {dumped}"
    assert "site-packages" not in dumped, f"内部布局泄露到对外裁决: {dumped}"
    assert verdict.get("error_code") == code or any(
        row.get("error_code") == code for row in verdict.get("signatures", [])
    ), f"缺少稳定错误码 {code}: {dumped}"
    # 日志必须留着原文，否则线上等于瞎了
    assert MARKER in caught.text, "原始异常没有进 sidecar 日志（排障依据丢失）"


# ---------------- 五处投毒点：异常含路径 → 出口不含、日志含 ----------------

def test_verifier_unavailable_hides_import_path(caught):
    """:121 pyHanko 依赖不可用。ImportError 会带上搜索过的 site-packages 路径。"""
    real_import = builtins.__import__

    def fake_import(name, *a, **kw):
        if name.startswith("pyhanko"):
            raise ImportError(f"No module named 'pyhanko'; searched {MARKER}")
        return real_import(name, *a, **kw)

    builtins.__import__ = fake_import
    try:
        v = vep.verify_pdf(b"%PDF-1.4\n%%EOF\n")
    finally:
        builtins.__import__ = real_import

    assert v["overall_ok"] is False
    assert_sanitized(v, vep.E_VERIFIER_UNAVAILABLE, caught)
    assert v["error"] == vep._SAFE_SUMMARY[vep.E_VERIFIER_UNAVAILABLE]


def test_trust_anchor_dir_path_is_not_leaked(monkeypatch, caught):
    """:126 信任锚目录不存在。基线把 _TRUST_ANCHOR_DIR 的绝对路径直接写进 error。"""
    monkeypatch.setattr(vep, "_TRUST_ANCHOR_DIR", os.path.join(MARKER, "trust_anchors"))
    v = vep.verify_pdf(unsigned_pdf())

    assert v["overall_ok"] is False
    assert_sanitized(v, vep.E_TRUST_ANCHOR_UNAVAILABLE, caught)
    assert v["error"] == vep._SAFE_SUMMARY[vep.E_TRUST_ANCHOR_UNAVAILABLE]


def test_pdf_parse_error_hides_exception_text(monkeypatch, caught):
    """:151 PDF/签名结构解析失败。"""
    import pyhanko.pdf_utils.reader as reader_mod

    def boom(*a, **kw):
        raise ValueError(f"broken xref while reading {MARKER}/tmp/in.pdf")

    monkeypatch.setattr(reader_mod, "PdfFileReader", boom)
    v = vep.verify_pdf(unsigned_pdf())

    assert v["overall_ok"] is False
    assert_sanitized(v, vep.E_PDF_UNPARSABLE, caught)
    assert v["error"] == vep._SAFE_SUMMARY[vep.E_PDF_UNPARSABLE]


def _stub_one_embedded_signature(monkeypatch):
    """让 verify_pdf 走到「逐个签名验签」那圈，不需要一份真的已签 PDF。"""
    import pyhanko.pdf_utils.reader as reader_mod

    class FakeEmbedded:
        field_name = "Signature1"

    class FakeReader:
        def __init__(self, *a, **kw):
            pass

        @property
        def embedded_signatures(self):
            return [FakeEmbedded()]

    monkeypatch.setattr(reader_mod, "PdfFileReader", FakeReader)


def test_signature_validation_exception_hides_path(monkeypatch, caught):
    """:232 单个签名验签抛异常。基线连异常类名一起外泄（`{type(e).__name__}: {e}`）。"""
    import pyhanko.sign.validation as validation_mod

    _stub_one_embedded_signature(monkeypatch)

    def boom(*a, **kw):
        raise RuntimeError(f"cert store unreadable: {MARKER}/certs")

    monkeypatch.setattr(validation_mod, "validate_pdf_signature", boom)
    v = vep.verify_pdf(unsigned_pdf())

    assert v["overall_ok"] is False
    assert v["num_signatures"] == 1
    row = v["signatures"][0]
    assert row["signature_ok"] is False
    assert_sanitized(v, vep.E_SIGNATURE_VERIFY_FAILED, caught)
    assert row["error"] == vep._SAFE_SUMMARY[vep.E_SIGNATURE_VERIFY_FAILED]
    # 异常类名也是内部信息，不该出现在对外文案里
    assert "RuntimeError" not in json.dumps(v, ensure_ascii=False)


def test_cli_read_failure_keeps_stdout_json_clean(monkeypatch, capsys, caught):
    """:254 CLI 读盘失败。stdout 只留可解析裁决，异常原文走日志。"""
    monkeypatch.setattr(sys, "argv", ["verify_evidence_pdf.py", f"{MARKER}/missing.pdf"])
    with pytest.raises(SystemExit) as ex:
        vep.main()
    assert ex.value.code == 1

    out = capsys.readouterr().out
    verdict = json.loads(out)   # stdout 仍是可解析 JSON
    assert verdict["overall_ok"] is False
    assert_sanitized(verdict, vep.E_PDF_READ_FAILED, caught)


# ---------------- 静态安全原因：原文保留 + 加码 ----------------

def test_unsigned_file_reason_survives_verbatim():
    """「没签名」是静态安全原因，用户必须看到原话，不能被兜底文案吞掉。"""
    v = vep.verify_pdf(unsigned_pdf())
    assert v["overall_ok"] is False
    assert v["num_signatures"] == 0
    assert v["error"] == "PDF 无嵌入数字签名（未签名文件，拒绝判通过）"
    assert v["error_code"] == vep.E_NO_SIGNATURE


def test_missing_cfca_anchor_reason_survives_verbatim(monkeypatch):
    monkeypatch.setattr(vep, "_load_and_classify_anchors", lambda: ([], ["ts"], None))
    v = vep.verify_pdf(unsigned_pdf())
    assert v["error_code"] == vep.E_MISSING_CFCA_ANCHOR
    assert v["error"].startswith("缺失 CFCA 签名信任锚")
    assert "拒绝判通过" in v["error"]


def test_missing_timestamp_anchor_reason_survives_verbatim(monkeypatch):
    monkeypatch.setattr(vep, "_load_and_classify_anchors", lambda: (["cfca"], [], None))
    v = vep.verify_pdf(unsigned_pdf())
    assert v["error_code"] == vep.E_MISSING_TSA_ANCHOR
    assert v["error"].startswith("缺失时间戳信任锚")


def test_every_fallback_code_has_a_registered_summary():
    """码表齐整性：异常兜底类的每个码都必须登记安全概述（app 侧按码做白名单要用）。"""
    fallback = {
        vep.E_VERIFIER_UNAVAILABLE, vep.E_TRUST_ANCHOR_UNAVAILABLE,
        vep.E_PDF_UNPARSABLE, vep.E_SIGNATURE_VERIFY_FAILED, vep.E_PDF_READ_FAILED,
    }
    assert fallback == set(vep._SAFE_SUMMARY), "码表与兜底分支对不上"
    for code, summary in vep._SAFE_SUMMARY.items():
        assert code.startswith("E_") and code.isascii(), f"错误码须是稳定 ASCII 常量: {code}"
        assert summary and "{" not in summary, f"安全概述不得含插值: {code}"


# ---------------- HTTP 边界：真正的对外出口 ----------------

def test_http_verify_response_body_has_no_server_path(monkeypatch, caught):
    """走 /verify 的真实出口再验一遍——sidecar 洗干净了、main.py 又漏回去也要红。"""
    import pyhanko.pdf_utils.reader as reader_mod

    def boom(*a, **kw):
        raise ValueError(f"broken xref while reading {MARKER}/tmp/in.pdf")

    monkeypatch.setattr(reader_mod, "PdfFileReader", boom)
    r = client.post("/verify", files={"file": ("x.pdf", unsigned_pdf(), "application/pdf")})

    assert r.status_code == 200
    assert MARKER not in r.text and "site-packages" not in r.text, r.text
    assert r.json()["error_code"] == vep.E_PDF_UNPARSABLE


# ---------------- 结构守卫：第六处写成同样的形状要被点名 ----------------

_ERROR_ASSIGN = re.compile(r'\["error"\]\s*=\s*(?P<rhs>.+?)\s*$')


def test_no_interpolated_string_is_ever_assigned_to_error():
    """出口只有一个（_safe_error）——以后有人再手写一处 `error = f"...{e}"` 必须被点名。

    只测「这五处现在干净」挡不住第六处：独立写 N 次忘 N 次是默认形态，不是疏忽。
    """
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "verify_evidence_pdf.py")
    with open(path, encoding="utf-8") as f:
        src = f.read()

    offenders = []
    for lineno, line in enumerate(src.splitlines(), 1):
        m = _ERROR_ASSIGN.search(line)
        if not m:
            continue
        rhs = m.group("rhs")
        if rhs.startswith(('f"', "f'")) or ".format(" in rhs or "%" in rhs or " + " in rhs:
            offenders.append(f"{path}:{lineno}: {line.strip()}")

    assert not offenders, (
        "对外 error 字段被插值字符串赋值（会把异常原文/服务器路径送出门）；"
        "改用 _safe_error(code, e) 并在 _SAFE_SUMMARY 登记概述：\n" + "\n".join(offenders)
    )
