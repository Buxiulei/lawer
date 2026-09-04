"""sidecar 端点单测（全离线，不打外部网络）。

运行: .venv/bin/python -m pytest tests -q
"""

import hashlib
import io
import os
import re
import sys
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gen_evidence_pdf  # noqa: E402
import main  # noqa: E402

client = TestClient(main.app)

# 生产的签章主体（签名证书 CN）。测试里当样例值用，不代表测试碰过真证书。
SIGNER_CN = "北京天开艾洛迪心理咨询有限公司"


def _payload():
    """一份最小但字段齐全的存证元数据。"""
    return {
        "order_no": "LAWER-ATT-20260819-000001",
        "generated_at": "2026-08-19T12:00:00+08:00",
        "issuer": "lawer 土八鼠",
        "signer_cn": SIGNER_CN,
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


def _pdf_text(pdf_bytes: bytes) -> str:
    """抽 PDF 正文文本并去掉所有空白，供「这几个字真的印在证上」的断言用。

    直接在 PDF 字节里搜中文是搜不到的：reportlab 把中文写成 TTF 子集里的字形号，
    要解 ToUnicode 表才还原得成文字。去空白是因为断行位置不该影响断言。
    """
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf_bytes))
    return "".join("".join(page.extract_text().split()) for page in reader.pages)


@pytest.fixture
def fake_pfx(tmp_path, monkeypatch):
    """现造一张自签证书打成 pfx 并指到 env 上。**绝不碰真实签名证书。**

    返回 (路径, CN)。CN 刻意不是生产那个名字：/signer 若哪天退化成返回写死的字符串，
    这条测试要能看出来。
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    cn = "北京测试签章有限公司"
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "测试集团"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(20260904)
        .not_valid_before(datetime(2026, 1, 1, tzinfo=timezone.utc))
        .not_valid_after(datetime(2027, 1, 1, tzinfo=timezone.utc))
        .sign(key, hashes.SHA256())
    )
    path = tmp_path / "test-signer.pfx"
    path.write_bytes(pkcs12.serialize_key_and_certificates(
        name=b"test-signer",
        key=key,
        cert=cert,
        cas=None,
        encryption_algorithm=serialization.BestAvailableEncryption(b"testpwd"),
    ))
    monkeypatch.setenv("SIGNING_CERT_PATH", str(path))
    monkeypatch.setenv("SIGNING_CERT_PASSWORD", "testpwd")
    return str(path), cn


# ---------------- /signer ----------------

def test_signer_returns_cert_cn(fake_pfx):
    """签章主体来自证书本身，不是代码里写死的字符串。"""
    _, cn = fake_pfx
    r = client.get("/signer")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["signer_cn"] == cn
    assert body["signer_org"] == "测试集团"
    assert body["serial"] == format(20260904, "x")
    assert body["not_before"].startswith("2026-01-01")
    assert body["not_after"].startswith("2027-01-01")


def test_signer_without_cert_returns_503(monkeypatch):
    """没配证书是「我方没就绪」，与 /pades 同一句话、同一个码。"""
    monkeypatch.delenv("SIGNING_CERT_PATH", raising=False)
    r = client.get("/signer")
    assert r.status_code == 503
    assert r.json()["detail"] == "未配置签名证书：SIGNING_CERT_PATH 为空"


def test_signer_wrong_password_returns_503(fake_pfx, monkeypatch):
    """口令不对也是配置问题；报错里不得回显口令或异常原文。"""
    monkeypatch.setenv("SIGNING_CERT_PASSWORD", "wrong")
    r = client.get("/signer")
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert "无法加载" in detail
    assert "wrong" not in detail


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


def test_evidence_pdf_prints_signer_line():
    """抬头真的印出了「签章主体」那一行，且值是 payload 里的 CN。

    只断言 200 是不够的：渲染层把这行漏掉、或印成别的名字，PDF 照样生成得出来。
    """
    pdf = client.post("/evidence-pdf", json=_payload()).content
    text = _pdf_text(pdf)
    assert "签章主体" in text
    assert f"签章主体：{SIGNER_CN}（出证平台运营主体）" in text
    # 出证平台仍在，签章主体是**加了一行**，不是把它换掉
    assert "出证平台：lawer土八鼠" in text


def test_evidence_pdf_prints_signature_law_note():
    """第五节声明④ 必须印出来，且主体名与抬头是同一个。

    这段告诉读者「Adobe 显示『签署者身份未知』属信任列表延迟、不代表签名无效」——
    它此前挂在一个调用方从没传过的可选字段上，四个月一次都没渲染出来过。
    """
    text = _pdf_text(client.post("/evidence-pdf", json=_payload()).content)
    assert f"④本PDF由{SIGNER_CN}持有的机构实名证书施加PAdES-B-LT数字签名" in text
    assert "签署者身份未知" in text
    assert "不代表签名无效或文档被篡改" in text


def test_signer_cn_flows_from_cert_into_pdf(fake_pfx):
    """接起来跑一遍：证书里的 CN → /signer → payload → 印在证上。

    上面两条分别只证明「/signer 会读证书」和「渲染层会印 payload 里的字」，
    合不合得上是另一回事——真正要保证的是**这两个名字是同一个**。
    """
    _, cn = fake_pfx
    signer_cn = client.get("/signer").json()["signer_cn"]
    p = _payload()
    p["signer_cn"] = signer_cn
    text = _pdf_text(client.post("/evidence-pdf", json=p).content)
    assert f"签章主体：{cn}（出证平台运营主体）" in text


@pytest.mark.parametrize("missing", ["order_no", "evidence", "issuer", "signer_cn"])
def test_evidence_pdf_rejects_incomplete_payload(missing):
    p = _payload()
    del p[missing]
    assert client.post("/evidence-pdf", json=p).status_code == 400


@pytest.mark.parametrize("missing", ["order_no", "issuer", "evidence", "signer_cn"])
def test_build_evidence_pdf_itself_refuses_incomplete(missing, tmp_path):
    """**直接 import 的那条路也要守住**，不能只守 HTTP 层。

    【为什么单独有这一条 —— 变异实测出来的】把生成器内部那道守撤掉、
    把 `p.get("issuer", "<写死的品牌名>")` 兜底放回去，**上面那条 HTTP 测试照样全绿**：
    它只走 `/evidence-pdf`，而 `build_evidence_pdf` 是模块 docstring 里就写明的公开入口
    （还有 CLI 用法）。
    ⇒ **只测 HTTP 层，等于让这条保证依赖"调用方走了哪条路"，而测试完全看不出来。**

    【变异体本身"真的坏"的证据（2026-08-28 补）】上面记的是"撤掉守卫后没有测试变红"——
    那只证明**守卫有缺口**，不证明**缺的这块真的会出事**：一个变异可以施加成功、编译合法、
    打中目标，却因为别处兜住而**根本不构成缺陷**，那种全绿是正确行为，读成"有缺口"是
    结论碰巧对、推理链断了。所以补了裸场景：撤守之后直接调 `build_evidence_pdf`
    （不经任何测试），它**不抛错、产出了一份 67KB 的 PDF，「出证平台」那栏印着
    `lawer 裁员应对专员`**——一个调用方从没传过、而且早已改名的品牌。
    缺陷是这份能发出去的证，不是"某条测试没红"。
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


def test_cjk_font_actually_loads():
    """中文字体必须真能被 reportlab 加载，否则整份 PDF 的中文渲成黑块。
    这条先于抽文本判据失败，把「缺哪种字体」说出来，而不是让三条判据一起报 ■。
    Noto Sans CJK 是 CFF 集合，reportlab 不吃；能用的是 wqy-zenhei / uming 这类 TrueType。"""
    import gen_evidence_pdf as g
    got = g.register_font()
    assert got == "CJK", (
        "没有可加载的 TrueType 中文字体，模板将退到 Helvetica（中文渲成黑块）。候选清单："
        + ", ".join(g._candidate_font_paths())
    )

