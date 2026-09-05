#!/usr/bin/env python3
"""
lawer sidecar —— FastAPI 服务（仅内网监听，供 Next.js app 调用）

保持薄：每个端点只做「校验入参 → 调对应模块函数 → 返回」，不写业务逻辑。
业务编排（存证订单、去重、落库）在 app 侧 lib/evidence。

启动见 README.md；默认 127.0.0.1:8100（env SIDECAR_HOST / SIDECAR_PORT）。
"""

import os
import tempfile
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from rfc3161_timestamp import DEFAULT_TSA, TimestampError, request_timestamp
from pades_sign import SignError, load_signer_info, sign_pdf_file
from gen_evidence_pdf import build_evidence_pdf
from verify_evidence_pdf import verify_pdf
from ocr import OcrError, ocr_image
from asr import AsrError, transcribe_audio
from video import (
    DEFAULT_FRAME_INTERVAL_S,
    DEFAULT_MAX_FRAMES,
    VideoError,
    extract_video,
)

app = FastAPI(title="lawer sidecar", version="0.1.0")

# 依赖不可用（未配 key / 未装 SDK）→ 503；上游报错 → 502；入参问题 → 400；超上限 → 413
_ERR_STATUS = {"config": 503, "input": 400, "limit": 413, "upstream": 502}


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


# ---------------- /signer ----------------

@app.get("/signer")
def signer():
    """读签名证书持有人信息，供《存证证明》抬头印「签章主体」。"""
    try:
        return load_signer_info()
    except SignError as e:
        raise HTTPException(status_code=503, detail=str(e))


# ---------------- /evidence-pdf ----------------

@app.post("/evidence-pdf")
def evidence_pdf(payload: dict):
    """按存证元数据渲染《存证证明》PDF（未签名）。payload 结构见 gen_evidence_pdf.py。"""
    if not payload.get("order_no"):
        raise HTTPException(status_code=400, detail="缺少 order_no")
    # issuer = 出证方名称。**不兜底**：这份 PDF 用户可能拿去仲裁庭，
    # 兜一个写死的品牌名等于替调用方编一个"谁出的证"。理由详见 gen_evidence_pdf.REQUIRED_TOP_LEVEL。
    if not payload.get("issuer"):
        raise HTTPException(status_code=400, detail="缺少 issuer")
    # signer_cn = 签章主体（签名证书 CN），同样**不兜底**：见 gen_evidence_pdf.REQUIRED_TOP_LEVEL。
    # 调用方应先 GET /signer 从证书里取，写死一个名字等于替证书回答「谁盖的章」。
    if not payload.get("signer_cn"):
        raise HTTPException(status_code=400, detail="缺少 signer_cn")
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

# /asr 的服务端超时（秒）。**必须与 app 侧 sidecar-client.ts 的 ENDPOINT_SPEC['/asr'] 同值**：
# 两边不一致时先到的那个先中止，另一边留下一个没人在等的任务——而排障的人只会看到
# 一边说超时、另一边说成功。
#
# 【为什么这条端点非要有服务端超时，别的没有】transcribe_audio 里是
# `Transcription.wait(...)`：提交一个异步转写任务，然后**同步阻塞轮询到它结束**，
# 没有任何时限。上游卡住时这个请求就永远挂着，占着一个 uvicorn 工作线程不放。
# 别的端点最坏也就是外呼那一次的超时（各模块自带 timeout），只有这条是无限等。
ASR_TIMEOUT_SECONDS = float(os.environ.get("ASR_TIMEOUT_SECONDS", "600"))

# 【为什么用线程池而不是 signal.alarm】signal 只能在主线程装，而 FastAPI 的同步端点
# 跑在工作线程里，装不上。
#
# ⚠ **超时不会杀掉那个线程**：Python 没有安全的强杀线程手段。超时只是让请求侧不再等，
# 那条线程会自己跑完（上游任务本来也在服务端继续跑）。max_workers 因此是一道闸：
# 最多同时挂 4 条僵住的转写，第 5 个请求会排队等位（等待时间同样计入本超时，
# 于是它照样会在 ASR_TIMEOUT_SECONDS 后拿到 504，而不是无声无息地挂着）。
_asr_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="asr")


@app.post("/asr")
def asr(
    file: UploadFile = File(..., description="待转写音频（单声道）"),
    speaker_count: int | None = Form(None, description="已知说话人数，可提升分离效果"),
):
    """录音转写 + 说话人分离（DashScope Paraformer），返回逐句结果。"""
    audio_bytes = file.file.read()
    future = _asr_pool.submit(
        transcribe_audio, audio_bytes, file.filename or "audio.wav", speaker_count
    )
    try:
        return future.result(timeout=ASR_TIMEOUT_SECONDS)
    except FutureTimeoutError:
        # 还没开跑的（在池子里排队）能取消掉，别让它过一会儿又去跑一遍没人要的转写；
        # 已经开跑的取消不了，只能等它自己结束（见上面的说明）。
        future.cancel()
        # 504 而不是 502：我方主动中止，上游并没有回过任何东西——
        # 报 502 会让排障的人去上游日志里找一条根本不存在的错误记录。
        raise HTTPException(
            status_code=504,
            detail=(
                f"转写超时：等了 {ASR_TIMEOUT_SECONDS:.0f} 秒仍未拿到结果，已主动中止。"
                "为什么：录音转写是提交异步任务后同步等结果，耗时随录音长度走，"
                "上游排队或音频过长都会超过这个时限。"
                "怎么办：确认录音时长在合理范围内后重试；反复超时请把这条错误连同录音时长报上来。"
            ),
        )
    except AsrError as e:
        raise HTTPException(status_code=_ERR_STATUS.get(e.code, 502), detail=str(e))


# ---------------- /video ----------------

@app.post("/video")
def video(
    file: UploadFile = File(..., description="待提取的视频"),
    max_frames: int = Form(DEFAULT_MAX_FRAMES, ge=1, le=120, description="关键帧张数上限"),
    frame_interval_s: float = Form(DEFAULT_FRAME_INTERVAL_S, gt=0, le=3600,
                                   description="抽帧间隔（秒）"),
):
    """视频抽音轨（16k 单声道 wav，供 /asr）与关键帧（JPEG，供 /ocr）。"""
    try:
        return extract_video(file.file, max_frames, frame_interval_s)
    except VideoError as e:
        raise HTTPException(status_code=_ERR_STATUS.get(e.code, 502), detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("SIDECAR_HOST", "127.0.0.1"),
        port=int(os.environ.get("SIDECAR_PORT", "8100")),
    )
