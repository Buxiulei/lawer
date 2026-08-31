"""验签裁决的对外错误分级（SYS-05b）——出口不漏路径，日志不丢原文。

【为什么这条测试存在】verify_evidence_pdf 的 `error` 字段不是内部字段：app 侧
`lib/evidence/recheck.ts` 会把它原样拼进公开复核页的失败理由，而 /verify/:no
是**匿名可访问**的。基线上有五处把裸 `{e}` / `{type(e).__name__}: {e}` 写进去，
其中信任锚那处直接把服务器绝对路径 `_TRUST_ANCHOR_DIR` 送出门。

判据分五层，缺一层就有变异能全绿穿过：
  1) 出口无路径 —— 断言的是**整份裁决 JSON 序列化后**不含标记串，
     不是只看 `error` 一个键（否则「换个字段继续漏」照样绿）；
  2) 日志有原文 —— 断言原始异常/明细进了 logger，
     否则「删干净就完事」会让线上彻底失去排障依据，测试却全绿；
  3) 静态安全原因原文保留 + 稳定码 —— 否则「一律换成一句通用兜底」也全绿，
     而那会把「这份文件根本没签名」这种用户必须知道的事实一起抹掉；
  4) 错误码**字面值**冻结 —— 只拿符号比（`== vep.E_NO_SIGNATURE`）时，改码值两边一起变，
     测试全绿而 app 侧按码做的白名单投影当场对不上；
  5) 结构守卫走**白名单** —— 只点名已知的插值语法挡不住「变量中转」和第六处新写法，
     反过来限定 `error` 的合法右值，不认识的形状一律点名。
"""

import ast
import builtins
import io
import json
import logging
import os
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


# 错误码是**跨进程契约**：app 侧按码做白名单投影（回填另单），码的字面值就是协议本身。
# 其余测试一律拿符号比（`== vep.E_NO_SIGNATURE`），符号两边一起变 → 改值全绿穿过：
# 把 E_NO_SIGNATURE 改成 "no_sig"、把 E_PDF_UNPARSABLE 改成 "E_PDF_BROKEN_V2"，
# 线上 app 的白名单当场对不上（原因栏变空白或掉进兜底），测试却一片绿。
# 所以这里钉死字面值——改码必须同时改这张表，改表时才会想起「app 侧白名单要同步」。
_FROZEN_ERROR_CODES = {
    "E_VERIFIER_UNAVAILABLE": "E_VERIFIER_UNAVAILABLE",
    "E_TRUST_ANCHOR_UNAVAILABLE": "E_TRUST_ANCHOR_UNAVAILABLE",
    "E_MISSING_CFCA_ANCHOR": "E_MISSING_CFCA_ANCHOR",
    "E_MISSING_TSA_ANCHOR": "E_MISSING_TSA_ANCHOR",
    "E_PDF_UNPARSABLE": "E_PDF_UNPARSABLE",
    "E_NO_SIGNATURE": "E_NO_SIGNATURE",
    "E_SIGNATURE_VERIFY_FAILED": "E_SIGNATURE_VERIFY_FAILED",
    "E_PDF_READ_FAILED": "E_PDF_READ_FAILED",
}


def test_error_code_literals_are_frozen_contract():
    """码表的字面值是冻结契约——静态三码与兜底五码一并钉死，改值即红。"""
    assert {name: getattr(vep, name) for name in _FROZEN_ERROR_CODES} == _FROZEN_ERROR_CODES
    # 名单也是封闭的：新增/删除一个码必须同步这张表（以及 app 侧的白名单投影）
    assert {n for n in vars(vep) if n.startswith("E_")} == set(_FROZEN_ERROR_CODES), (
        "码表增减了成员却没同步冻结表；app 侧按码投影，未登记的码到了前端就是「未知原因」"
    )


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


# ---------------- 结构守卫：error 的右值走白名单 ----------------
#
# 【为什么不是黑名单】上一版守卫枚举「插值语法」（f"" / .format / % / +）来点名。
# 枚举挡不住换个形状写的同一件事——**变量中转**只要绕一手就静默穿过：
#     detail = f"{type(e).__name__}: {e}"
#     result["error"] = detail          # 右值只是个名字，黑名单看不见
# 而且黑名单是「列举已知的坏」，第六种坏写法天然在名单外。
#
# 所以反过来：**白名单**。能落进对外 error 字段的值只有两种形状——
#   1) _safe_error(...) 的返回（异常兜底类的唯一出口，原文另进日志）；
#   2) 模块级、纯字符串字面量的常量名（静态安全原因，不携带运行期数据——
#      但**挡不住有人把服务器路径硬编码进字面量本身**，那一类只能靠 review，别把本守卫当它的判据）；
#   （None 是初始化占位，不携带任何数据，一并放行。）
# 其余一概点名，不管它长什么样——这才是「不认识的东西默认不放行」。
#
# 【射程如实声明】本守卫只识别两种**寻址形状**：下标赋值 `X["error"] = V`（含元组解包与
# 原地追加）与字典字面量 `{"error": V}`（CLI 那条 stdout 裁决走的就是它，黑名单版从没看过）。
# `X.update(error=...)`、`setdefault`、`_k = "error"; X[_k] = ...` 这类写法**穿得过去**——
# 终审实测五条此类变异全部存活。不要据此认为它们安全；根治=把「error 的每个写入点」收唯一
# 入口后反向点名（扫源码里 "error" 的每次出现，凡不落在已识别写入点上的报警），
# 已结转 app 侧 error_code 回填单一并做。在那之前，动 verify_evidence_pdf.py 的人
# 自觉只用已覆盖的两种形状写 error。

_VEP_SRC_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "verify_evidence_pdf.py")


def _module_str_constants(tree: ast.Module) -> set:
    """模块级、值为纯字符串字面量的常量名（f-string / 拼接 / 函数返回都不算）。"""
    names = set()
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not (isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                names.add(target.id)
    return names


def _is_error_key(node) -> bool:
    return (isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant)
            and node.slice.value == "error")


def _error_field_writes(tree: ast.Module):
    """产出 (行号, 右值节点)：每一处会落进对外 error 字段的值。"""
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            flat = []
            for target in node.targets:
                flat.extend(target.elts if isinstance(target, (ast.Tuple, ast.List))
                            else [target])
            if any(_is_error_key(t) for t in flat):
                yield node.lineno, node.value
        elif isinstance(node, ast.AugAssign):
            if _is_error_key(node.target):
                yield node.lineno, node.value
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and key.value == "error":
                    yield value.lineno, value


def _rhs_allowed(value, const_names: set) -> bool:
    if (isinstance(value, ast.Call) and isinstance(value.func, ast.Name)
            and value.func.id == "_safe_error"):
        return True
    if isinstance(value, ast.Name) and value.id in const_names:
        return True
    return isinstance(value, ast.Constant) and value.value is None


def error_rhs_offenders(src: str, path: str = "<src>") -> list:
    """返回所有「右值不在白名单里」的 error 写入点（行号 + 原文）。"""
    tree = ast.parse(src)
    const_names = _module_str_constants(tree)
    lines = src.splitlines()
    return [
        f"{path}:{lineno}: {lines[lineno - 1].strip()}"
        for lineno, value in _error_field_writes(tree)
        if not _rhs_allowed(value, const_names)
    ]


def test_error_field_only_takes_whitelisted_right_hand_sides():
    """对外 error 字段只收 _safe_error(...) 或模块级无插值常量，第六处怎么绕都要被点名。"""
    with open(_VEP_SRC_PATH, encoding="utf-8") as f:
        src = f.read()

    # 先验量具：扫不到写入点说明守卫已经瞎了（源文件结构变了 / 路径拼错），
    # 那时「零违规」是假绿。当前源文件 11 处（5 处 _safe_error + 3 处静态常量 + 3 处 None 初始化）。
    writes = list(_error_field_writes(ast.parse(src)))
    assert len(writes) >= 8, f"守卫只扫到 {len(writes)} 处 error 写入点，先确认守卫本身还有效"

    offenders = error_rhs_offenders(src, _VEP_SRC_PATH)
    assert not offenders, (
        "对外 error 字段收了白名单外的右值（会把异常原文/服务器路径送出门）；"
        "兜底类改用 `x['error_code'], x['error'] = _safe_error(code, e)` 并在 _SAFE_SUMMARY "
        "登记概述，静态安全原因写成模块级常量再引用：\n" + "\n".join(offenders)
    )


# 守卫自检（正例）：白名单内的三种形状不许被误判为违规。
_GUARD_ACCEPTS = '''
_REASON_X = "静态安全原因，无插值"


def f(e):
    result = {"overall_ok": False, "error": None, "error_code": None}
    result["error_code"], result["error"] = _safe_error(E_X, e)
    result["error"] = _REASON_X
    return result
'''

# 守卫自检（反例）：这些形状全是「把运行期数据送进对外字段」的同一件事，
# 少抓一种，第六处就从那种形状溜出去。
_GUARD_MUST_CATCH = {
    "变量中转": 'def f(e):\n    detail = f"炸了: {e}"\n    result["error"] = detail\n',
    "元组中转": 'def f(e):\n    code, msg = _safe_error(E_X, e)\n'
                '    result["error_code"], result["error"] = code, msg\n',
    "新增第六处间接赋值": 'def f(e):\n    if bad:\n        detail = describe(e)\n'
                          '        result["error"] = detail\n',
    "就地 f-string": 'def f(e):\n    result["error"] = f"炸了: {e}"\n',
    "字符串拼接": 'def f(e):\n    result["error"] = "炸了: " + str(e)\n',
    "百分号格式化": 'def f(e):\n    result["error"] = "炸了: %s" % e\n',
    "format 方法": 'def f(e):\n    result["error"] = "炸了: {}".format(e)\n',
    "别的函数中转": 'def f(e):\n    result["error"] = _describe(e)\n',
    "原地追加": 'def f(e):\n    result["error"] += str(e)\n',
    "字典字面量夹带": 'def f(e):\n    return {"overall_ok": False, "error": f"{e}"}\n',
    "非模块级常量中转": 'def f(e):\n    reason = "看着像常量，其实是局部名"\n'
                        '    reason = f"{reason}: {e}"\n    result["error"] = reason\n',
}


@pytest.mark.parametrize("shape", sorted(_GUARD_MUST_CATCH))
def test_guard_catches_every_known_leak_shape(shape):
    """守卫自身的判据：它必须真的抓得住这些形状，否则「全绿」只是没看见。"""
    assert error_rhs_offenders(_GUARD_MUST_CATCH[shape]), f"守卫漏掉了「{shape}」这种写法"


def test_guard_does_not_flag_the_whitelisted_shapes():
    """反向自检：白名单内的写法不许误伤，否则守卫会被人「修」成永远不响。"""
    assert error_rhs_offenders(_GUARD_ACCEPTS) == []
