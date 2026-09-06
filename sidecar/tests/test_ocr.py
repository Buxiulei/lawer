"""/ocr 端点与 ocr_image 的单测（全离线，requests.post 被替身拦下，不打外部网络）。

覆盖：默认模型名、成功回包契约 {text, model, request_id}、请求体形状（不含
ocr_options、image_url 为 base64 data URI）、403/429 自述三段式、5xx 与超时的重试与失败。

运行: .venv/bin/python -m pytest tests/test_ocr.py -q
"""

import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ocr  # noqa: E402
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)

# 够当「非空图片」用；OCR 上游被替身拦下，不会真解码这几个字节。
IMG = b"\xff\xd8\xff\xe0fakejpeg"


class FakeResp:
    """替身 HTTP 响应，够 ocr_image 读的字段。"""

    def __init__(self, status_code, json_body=None, headers=None, text=""):
        self.status_code = status_code
        self._json = json_body
        self.headers = headers or {}
        self.text = text

    def json(self):
        if self._json is None:
            raise ValueError("响应体不是 JSON")
        return self._json


def _ok_body(content="解除劳动合同通知书\n甲方：某公司", rid="chatcmpl-abc123"):
    """兼容端点的正常回包结构。"""
    return {
        "id": rid,
        "model": "qwen3-vl-plus",
        "choices": [{"message": {"role": "assistant", "content": content}}],
    }


class Recorder:
    """替身 requests.post：按脚本依次返回/抛错（脚本耗尽后重复末项），并记录每次入参。"""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def __call__(self, url, headers=None, json=None, timeout=None):
        self.calls.append(
            {"url": url, "headers": headers, "json": json, "timeout": timeout}
        )
        idx = min(len(self.calls) - 1, len(self.script) - 1)
        item = self.script[idx]
        if isinstance(item, Exception):
            raise item
        return item


def _patch(monkeypatch, script):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-key")
    rec = Recorder(script)
    monkeypatch.setattr(ocr.requests, "post", rec)
    return rec


# ---------------- 默认模型名（TODO 判据） ----------------

def test_ocr_default_model():
    """默认模型暂锁浮动别名 qwen3-vl-plus。

    这是过渡态：生产 key 对 dated 名（qwen3-vl-plus-2025-12-19 等）一律 403，
    只有浮动别名能 200。主理人开通 dated 名后，把默认值与本断言一并改成 dated 名
    （见 ocr.py 文件头 TODO）。
    """
    assert ocr.DEFAULT_OCR_MODEL == "qwen3-vl-plus"


# ---------------- 成功：回包契约不变 ----------------

def test_ocr_success_returns_contract(monkeypatch):
    rec = _patch(monkeypatch, [FakeResp(200, _ok_body(content="全文A", rid="req-1"))])
    out = ocr.ocr_image(IMG, "image/jpeg")
    assert out == {"text": "全文A", "model": "qwen3-vl-plus", "request_id": "req-1"}
    assert len(rec.calls) == 1


def test_ocr_endpoint_preserves_contract(monkeypatch):
    """端到端过 /ocr：app 侧 worker 靠 {text, model, request_id} 三键，必须原样。"""
    _patch(monkeypatch, [FakeResp(200, _ok_body(content="端到端全文", rid="req-e2e"))])
    r = client.post("/ocr", files={"file": ("a.jpg", IMG, "image/jpeg")})
    assert r.status_code == 200
    assert r.json() == {
        "text": "端到端全文", "model": "qwen3-vl-plus", "request_id": "req-e2e"
    }


def test_ocr_request_id_prefers_header(monkeypatch):
    """request_id 优先取响应头 X-Request-Id，无头再退回 body 的 id。"""
    _patch(monkeypatch, [FakeResp(
        200, _ok_body(rid="body-id"), headers={"X-Request-Id": "header-id"}
    )])
    out = ocr.ocr_image(IMG)
    assert out["request_id"] == "header-id"


# ---------------- 请求体形状 ----------------

def test_ocr_request_body_shape(monkeypatch):
    """请求体不含 ocr_options，图片以 base64 data URI 内联（image_url）。

    变异臂：若加回 ocr_options ⇒ 首条断言红；若图片不走 data URI ⇒ 末条断言红。
    """
    rec = _patch(monkeypatch, [FakeResp(200, _ok_body())])
    ocr.ocr_image(IMG, "image/png")

    call = rec.calls[0]
    assert call["url"] == ocr.OCR_ENDPOINT
    assert call["headers"]["Authorization"] == "Bearer test-key"
    assert call["timeout"] == ocr.OCR_TIMEOUT_S

    body = call["json"]
    assert "ocr_options" not in body
    assert body["model"] == "qwen3-vl-plus"

    content = body["messages"][0]["content"]
    img_parts = [p for p in content if p.get("type") == "image_url"]
    assert len(img_parts) == 1
    assert img_parts[0]["image_url"]["url"].startswith("data:image/png;base64,")


# ---------------- 403 / 429：自述三段式，不重试 ----------------

def test_ocr_403_is_self_describing_config_error(monkeypatch):
    rec = _patch(monkeypatch, [FakeResp(
        403, {"error": {"code": "Model.AccessDenied", "message": "no access"}}
    )])
    with pytest.raises(ocr.OcrError) as ei:
        ocr.ocr_image(IMG)
    err = ei.value
    assert err.code == "config"          # → main 映射 503
    msg = str(err)
    assert "qwen3-vl-plus" in msg         # 点名模型
    assert "OCR_MODEL" in msg             # 提示覆盖手段
    assert len(rec.calls) == 1            # 403 不重试


def test_ocr_429_is_self_describing_no_retry(monkeypatch):
    rec = _patch(monkeypatch, [FakeResp(429, {"error": {"message": "rate limited"}})])
    with pytest.raises(ocr.OcrError) as ei:
        ocr.ocr_image(IMG)
    assert ei.value.code == "upstream"    # → main 映射 502
    assert "限流" in str(ei.value)
    assert len(rec.calls) == 1            # 429 不重试


# ---------------- 5xx / 超时：重试两次后失败 ----------------

def test_ocr_5xx_retries_twice_then_fails(monkeypatch):
    """5xx 重试两次（共 3 次请求）后失败。变异臂：去掉重试 ⇒ 调用数变 1 ⇒ 红。"""
    rec = _patch(monkeypatch, [FakeResp(503, {"error": {"message": "upstream down"}})])
    with pytest.raises(ocr.OcrError) as ei:
        ocr.ocr_image(IMG)
    assert ei.value.code == "upstream"
    assert len(rec.calls) == 3            # 1 初始 + 2 重试
    assert "重试" in str(ei.value)


def test_ocr_timeout_retries_then_fails(monkeypatch):
    rec = _patch(monkeypatch, [requests.exceptions.Timeout("slow")])
    with pytest.raises(ocr.OcrError) as ei:
        ocr.ocr_image(IMG)
    assert ei.value.code == "upstream"
    assert len(rec.calls) == 3            # 超时也重试两次
    assert "超时" in str(ei.value)


# ---------------- 未配置 key ----------------

def test_ocr_without_key_returns_503(monkeypatch):
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    r = client.post("/ocr", files={"file": ("a.jpg", IMG, "image/jpeg")})
    assert r.status_code == 503
    assert "DASHSCOPE_API_KEY" in r.json()["detail"]
