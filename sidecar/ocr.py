#!/usr/bin/env python3
"""
图片 OCR —— DashScope Qwen-VL OCR

用于公司文件（解除通知 / 调岗通知 / PIP / 协商协议等）拍照后的全文提取，
提取结果交由 app 侧 agent 做风险标注与「签/不签/改签」建议（spec §8 OCR 行）。

图片以 base64 data URI 内联提交：不走 SDK 的「本地文件先传阿里云临时 OSS」路径，
避免劳动者的公司文件在推理之外多落一处存储。

key 从 env DASHSCOPE_API_KEY 读；模型从 env OCR_MODEL 读。

默认值锁死 dated 版本号 qwen-vl-ocr-2025-11-20（0.3/0.5 元每百万 token），
**不用 qwen-vl-ocr-latest 之类浮动别名**：别名指向变更会把单价拉到老版的 5/5 元，
差 16 倍（见 research/raw/C01-模型定价核定.md §二）。换版必须显式改这里或 env。
"""

import base64
import os
from http import HTTPStatus

DEFAULT_OCR_MODEL = os.environ.get("OCR_MODEL", "qwen-vl-ocr-2025-11-20")
DEFAULT_PROMPT = "请完整提取图片中的所有文字，保持原有段落与换行顺序，不要翻译、不要总结、不要补充说明。"


class OcrError(Exception):
    """OCR 失败。code 用于上层映射 HTTP 状态：config=未配置，upstream=上游报错。"""

    def __init__(self, message: str, code: str = "upstream"):
        super().__init__(message)
        self.code = code


def ocr_image(image_bytes: bytes, mime: str = "image/jpeg", prompt: str = None,
              model: str = None) -> dict:
    """对一张图片做 OCR，返回 {text, model, request_id}。失败抛 OcrError。"""
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        raise OcrError("未配置 DASHSCOPE_API_KEY，OCR 不可用", code="config")
    if not image_bytes:
        raise OcrError("图片内容为空", code="input")

    try:
        import dashscope
    except ImportError as e:
        raise OcrError(f"dashscope SDK 不可用: {e}", code="config")

    model = model or DEFAULT_OCR_MODEL
    data_uri = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"

    try:
        response = dashscope.MultiModalConversation.call(
            api_key=api_key,
            model=model,
            messages=[{
                "role": "user",
                "content": [
                    {"image": data_uri},
                    {"text": prompt or DEFAULT_PROMPT},
                ],
            }],
            ocr_options={"task": "text_recognition"},
        )
    except Exception as e:
        raise OcrError(f"调用 DashScope 失败: {type(e).__name__}: {e}")

    # SDK 对服务端错误不抛异常，而是回填非 200 status_code
    if response.status_code != HTTPStatus.OK:
        # 403 Model.AccessDenied 是「该 key 没开通这个模型」，不是代码问题。
        # 我们刻意锁 dated 版本号（见文件头），而 dated 版需在百炼控制台单独开通，
        # 报错必须点名这一点，否则排查会绕远路。
        if response.status_code == 403 and response.code == "Model.AccessDenied":
            raise OcrError(
                f"DashScope 拒绝访问模型 {model}：该 API key 未开通此模型。"
                f"请在百炼控制台为该 key 开通 {model}（本项目按定价核定锁 dated 版本号，"
                f"不使用 -latest 浮动别名）；临时排障可用 env OCR_MODEL 覆盖。",
                code="config",
            )
        raise OcrError(
            f"DashScope 返回错误 status={response.status_code} code={response.code} "
            f"message={response.message}"
        )

    try:
        content = response.output.choices[0].message.content
    except (AttributeError, IndexError, TypeError) as e:
        raise OcrError(f"DashScope 返回结构异常: {e}")

    # content 为 list[dict]，正常情况下取首元素的 text
    if isinstance(content, list):
        text = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    else:
        text = str(content or "")

    return {
        "text": text,
        "model": model,
        "request_id": getattr(response, "request_id", None),
    }
