#!/usr/bin/env python3
"""
lawer sidecar —— FastAPI 服务（仅内网监听，供 Next.js app 调用）

保持薄：每个端点只做「校验入参 → 调对应模块函数 → 返回」，不写业务逻辑。
业务编排（存证订单、去重、落库）在 app 侧 lib/evidence。

启动见 README.md；默认 127.0.0.1:8100（env SIDECAR_HOST / SIDECAR_PORT）。
"""

import os
import tempfile

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from rfc3161_timestamp import DEFAULT_TSA, TimestampError, request_timestamp
from pades_sign import SignError, sign_pdf_file
from gen_evidence_pdf import build_evidence_pdf
from verify_evidence_pdf import verify_pdf
from ocr import OcrError, ocr_image
from asr import AsrError, transcribe_audio

app = FastAPI(title="lawer sidecar", version="0.1.0")

# 依赖不可用（未配 key / 未装 SDK）→ 503；上游报错 → 502；入参问题 → 400
_ERR_STATUS = {"config": 503, "input": 400, "upstream": 502}


@app.get("/health")
def health():
    """容器健康检查。"""
    return {"ok": True}


# ---------------- /tsa ----------------

class TsaRequest(BaseModel):
    # 64 位 hex 由 pydantic 拦下（不合规 → 422），故下游只需处理 TSA 侧失败
    sha256: str = Field(..., pattern=r"^[0-9a-fA-F]{64}$", description="待盖章的 SHA-256（hex）")
    tsa_url: str | None = Field(None, description="RFC3161 TSA URL，缺省用 env TSA_URL")
    timeout: int = Field(15, ge=1, le=120, description="TSA 请求超时（秒）")


@app.post("/tsa")
def tsa(req: TsaRequest):
    """对一个 SHA-256 申请 RFC3161 可信时间戳。"""
    try:
        return request_timestamp(req.sha256, req.tsa_url or DEFAULT_TSA, req.timeout)
    except TimestampError as e:
        raise HTTPException(status_code=502, detail=str(e))


# ---------------- /pades ----------------

@app.post("/pades")
def pades(
    file: UploadFile = File(..., description="待签名 PDF"),
    reason: str | None = Form(None),
    location: str | None = Form(None),
):
    """对上传的 PDF 施加 PAdES-B-LT 签名，返回签名后 PDF。"""
    src = file.file.read()
    if not src:
        raise HTTPException(status_code=400, detail="上传文件为空")

    kwargs = {}
    if reason:
        kwargs["reason"] = reason
    if location:
        kwargs["location"] = location

    with tempfile.TemporaryDirectory() as td:
        in_path = os.path.join(td, "in.pdf")
        out_path = os.path.join(td, "out.pdf")
        with open(in_path, "wb") as f:
            f.write(src)
        try:
            r = sign_pdf_file(in_path, out_path, **kwargs)
        except SignError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"签名失败: {type(e).__name__}: {e}")
        with open(out_path, "rb") as f:
            signed = f.read()

    headers = {
        "Content-Disposition": 'attachment; filename="signed.pdf"',
        "X-Source-Sha256": r["source_sha256"],
    }
    if r["ltv_warning"]:
        # LTV 未嵌成不影响签名有效性，但调用方应记录以便排查
        headers["X-Ltv-Warning"] = r["ltv_warning"].encode("ascii", "replace").decode("ascii")
    return Response(content=signed, media_type="application/pdf", headers=headers)


# ---------------- /evidence-pdf ----------------

@app.post("/evidence-pdf")
def evidence_pdf(payload: dict):
    """按存证元数据渲染《存证证明》PDF（未签名）。payload 结构见 gen_evidence_pdf.py。"""
    if not payload.get("order_no"):
        raise HTTPException(status_code=400, detail="缺少 order_no")
    if not (payload.get("evidence") or {}).get("sha256"):
        raise HTTPException(status_code=400, detail="缺少 evidence.sha256")

    with tempfile.TemporaryDirectory() as td:
        out_path = os.path.join(td, "evidence.pdf")
        try:
            build_evidence_pdf(payload, out_path)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"生成 PDF 失败: {type(e).__name__}: {e}")
        with open(out_path, "rb") as f:
            pdf = f.read()

    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="evidence.pdf"'},
    )


# ---------------- /verify ----------------

@app.post("/verify")
def verify(
    file: UploadFile = File(..., description="待验签 PDF"),
    expect_hash: str | None = Form(None, description="期望的整份 PDF SHA-256"),
):
    """对上传 PDF 做独立 PAdES 密码学验签，返回裁决 JSON。

    验签不通过不是 HTTP 错误：一律 200 返回裁决，由调用方读 overall_ok。
    """
    pdf_bytes = file.file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="上传文件为空")
    return JSONResponse(content=verify_pdf(pdf_bytes, expect_hash))


# ---------------- /ocr ----------------

@app.post("/ocr")
def ocr(
    file: UploadFile = File(..., description="待识别图片"),
    prompt: str | None = Form(None),
):
    """图片 OCR（DashScope Qwen-VL），返回全文文本。"""
    image_bytes = file.file.read()
    try:
        return ocr_image(image_bytes, file.content_type or "image/jpeg", prompt)
    except OcrError as e:
        raise HTTPException(status_code=_ERR_STATUS.get(e.code, 502), detail=str(e))


# ---------------- /asr ----------------

@app.post("/asr")
def asr(
    file: UploadFile = File(..., description="待转写音频（单声道）"),
    speaker_count: int | None = Form(None, description="已知说话人数，可提升分离效果"),
):
    """录音转写 + 说话人分离（DashScope Paraformer），返回逐句结果。"""
    audio_bytes = file.file.read()
    try:
        return transcribe_audio(audio_bytes, file.filename or "audio.wav", speaker_count)
    except AsrError as e:
        raise HTTPException(status_code=_ERR_STATUS.get(e.code, 502), detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("SIDECAR_HOST", "127.0.0.1"),
        port=int(os.environ.get("SIDECAR_PORT", "8100")),
    )
