#!/usr/bin/env python3
"""
图片 OCR —— DashScope Qwen3-VL（OpenAI 兼容 chat/completions 面）

用于公司文件（解除通知 / 调岗通知 / PIP / 协商协议等）拍照后的全文提取，
提取结果交由 app 侧 agent 做风险标注与「签/不签/改签」建议（spec §8 OCR 行）。

图片以 base64 data URI 内联提交（image_url）：不走 SDK 的「本地文件先传阿里云临时
OSS」路径，避免劳动者的公司文件在推理之外多落一处存储。

调用走 DashScope 的 OpenAI 兼容端点 chat/completions（不用 dashscope SDK 的
MultiModalConversation，也不带 ocr_options）：与 NBDpsy 发票 OCR 同一条通路，
生产环境已验证该 key 能走通。

key 从 env DASHSCOPE_API_KEY 读；模型从 env OCR_MODEL 读。

------------------------------------------------------------------------------
默认模型为什么是浮动别名 qwen3-vl-plus（不用带日期版本）
------------------------------------------------------------------------------
百炼的模型授权按「精确模型名」开通：生产这把 key（与 NBDpsy 同一把）对
qwen-vl-ocr-2025-11-20 / qwen-vl-ocr / qwen-vl-plus / qwen3-vl-plus-2025-12-19
等一律 403 Model.AccessDenied，只有浮动别名 qwen3-vl-plus（与 qwen-vl-max）能 200。

主理人 2026-09-07 裁决：**不用带日期版本**——浮动别名就是这里的定值，不是过渡态。
（原先此处挂着一条"开通 dated 名后改回去"的 TODO，按裁决删除。）
换版走 env OCR_MODEL，并同步核对 research/raw/C01-模型定价核定.md 的费率表。
"""

import base64
import os

import requests

DEFAULT_OCR_MODEL = os.environ.get("OCR_MODEL", "qwen3-vl-plus")
DEFAULT_PROMPT = "请完整提取图片中的所有文字，保持原有段落与换行顺序，不要翻译、不要总结、不要补充说明。"

# DashScope OpenAI 兼容端点（chat/completions）
OCR_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
# 单次请求超时（秒）。OCR 是同步等结果，整页密集文档最慢也在这个量级内。
OCR_TIMEOUT_S = 120
# 仅对 5xx / 超时重试的次数（1 次初始 + 2 次重试 = 最多 3 次请求）。
# 403/429/4xx 是确定性错误，重试无意义、只会放大限流，故不重试。
OCR_MAX_RETRIES = 2
# 输出上限。劳动文件多为 1~2 页，4096 token 足以容下整页中文全文而不截断。
OCR_MAX_TOKENS = 4096


class OcrError(Exception):
    """OCR 失败。code 用于上层映射 HTTP 状态：config=未配置/未开通，upstream=上游报错。"""

    def __init__(self, message: str, code: str = "upstream"):
        super().__init__(message)
        self.code = code


def _upstream_error_text(resp) -> str:
    """从非 200 响应里抽出可读的上游错误文案（兼容端点的 error 结构）。"""
    try:
        body = resp.json()
    except ValueError:
        return (resp.text or "")[:300]
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        return f"code={err.get('code')} message={err.get('message')}"
    return str(body)[:300]


def ocr_image(image_bytes: bytes, mime: str = "image/jpeg", prompt: str = None,
              model: str = None) -> dict:
    """对一张图片做 OCR，返回 {text, model, request_id}。失败抛 OcrError。"""
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        raise OcrError("未配置 DASHSCOPE_API_KEY，OCR 不可用", code="config")
    if not image_bytes:
        raise OcrError("图片内容为空", code="input")

    model = model or DEFAULT_OCR_MODEL
    data_uri = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt or DEFAULT_PROMPT},
                {"type": "image_url", "image_url": {"url": data_uri}},
            ],
        }],
        "max_tokens": OCR_MAX_TOKENS,
    }

    # 记录最后一次「可重试失败」的原因，供重试用尽后拼自述三段式错误
    last_transient = None
    for attempt in range(OCR_MAX_RETRIES + 1):
        try:
            resp = requests.post(
                OCR_ENDPOINT, headers=headers, json=payload, timeout=OCR_TIMEOUT_S
            )
        except requests.exceptions.Timeout:
            last_transient = f"第 {attempt + 1} 次请求超时（>{OCR_TIMEOUT_S:.0f}s）"
            continue
        except requests.exceptions.RequestException as e:
            # 连接层错误（DNS/拒连等）不是上游 5xx，不重试，据实回传
            raise OcrError(
                f"调用 DashScope OCR 失败：{type(e).__name__}: {e}。"
                f"为什么：无法连到 OCR 上游 {OCR_ENDPOINT}。"
                "怎么办：检查 sidecar 的出网与 DNS 后重试。"
            )

        code = resp.status_code
        if code == 200:
            try:
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
            except (ValueError, KeyError, IndexError, TypeError) as e:
                raise OcrError(f"DashScope 返回结构异常: {type(e).__name__}: {e}")
            # 兼容端点下 content 通常是 str；防御性处理 list（多模态分段）
            if isinstance(content, list):
                text = "".join(
                    p.get("text", "") for p in content if isinstance(p, dict)
                )
            else:
                text = str(content or "")
            request_id = resp.headers.get("X-Request-Id")
            if not request_id and isinstance(data, dict):
                request_id = data.get("id")
            return {"text": text, "model": model, "request_id": request_id}

        if code == 403:
            # 403 是「该 key 未开通这个精确模型名」，不是代码问题。百炼按精确名授权，
            # 报错必须点名模型与 OCR_MODEL 覆盖手段，否则排查会绕远路（见文件头 TODO）。
            raise OcrError(
                f"该 key 未开通 {model}：DashScope 返回 403 拒绝访问。"
                "为什么：百炼按精确模型名授权，这把 key 尚未获授该模型。"
                f"怎么办：在百炼控制台为该 key 开通 {model}，"
                "或用 env OCR_MODEL 覆盖成已开通的模型名。",
                code="config",
            )

        if code == 429:
            # 限流是配额问题，不重试（重试只会加剧限流）。
            raise OcrError(
                f"OCR 上游限流：DashScope 对 {model} 返回 429 Too Many Requests。"
                "为什么：该 key 的调用频次或并发超过百炼配额。"
                "怎么办：降低并发或稍后重试；持续限流请在百炼控制台提额。"
            )

        if 500 <= code < 600:
            last_transient = f"第 {attempt + 1} 次上游 5xx（status={code}）"
            continue

        # 其它非 200（400/401 等）——确定性错误，不重试，据实回传
        raise OcrError(
            f"DashScope 返回错误 status={code}：{_upstream_error_text(resp)}"
        )

    # 重试用尽仍失败（只有 5xx / 超时会走到这里）
    raise OcrError(
        f"OCR 上游连续失败：{last_transient}，已重试 {OCR_MAX_RETRIES} 次仍未成功。"
        "为什么：DashScope 服务端 5xx 或响应超时属上游临时故障。"
        "怎么办：稍后重试；持续失败请把本条错误连同发生时间报上来。"
    )
