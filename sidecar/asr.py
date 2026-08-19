#!/usr/bin/env python3
"""
录音转写 + 说话人分离 —— DashScope Paraformer（录音文件识别）

用于劳动者与公司谈话录音的逐句转写与说话人标注，供 app 侧做「谁在什么时候说了什么」
的证据梳理（spec §8 evidence / 录音分析）。

重要约束（阿里云官方）：录音文件识别接口 **只接受公网可访问的 URL，不接受二进制流或
本地文件路径**。故本模块先用 SDK 的 OssUtils 把音频上传到 DashScope 临时文件空间
（48 小时有效），拿到 oss:// URL 再提交任务，请求头须带 X-DashScope-OssResourceResolve。
官方说明该临时空间限流 100 QPS 且不扩容、不建议用于高并发生产场景；量上来后应改为
上传到自有 OSS 取公网 URL（届时把 ASR_UPLOAD_MODE 切到 oss 并补实现）。

说话人分离仅支持单声道音频，多声道需先 ffmpeg -ac 1 转单声道。

key 从 env DASHSCOPE_API_KEY 读；模型从 env ASR_MODEL 读（默认 paraformer-v2）。
"""

import os
import tempfile
from http import HTTPStatus

DEFAULT_ASR_MODEL = os.environ.get("ASR_MODEL", "paraformer-v2")


class AsrError(Exception):
    """转写失败。code 用于上层映射 HTTP 状态：config=未配置，upstream=上游报错。"""

    def __init__(self, message: str, code: str = "upstream"):
        super().__init__(message)
        self.code = code


def transcribe_audio(audio_bytes: bytes, filename: str = "audio.wav",
                     speaker_count: int = None, model: str = None) -> dict:
    """转写一段音频并做说话人分离，返回 {text, sentences[], model, task_id}。

    sentences 每项：{text, begin_time(ms), end_time(ms), speaker_id, sentence_id}
    失败抛 AsrError。
    """
    api_key = os.environ.get("DASHSCOPE_API_KEY")
    if not api_key:
        raise AsrError("未配置 DASHSCOPE_API_KEY，转写不可用", code="config")
    if not audio_bytes:
        raise AsrError("音频内容为空", code="input")

    try:
        from dashscope.audio.asr import Transcription
        from dashscope.utils.oss_utils import OssUtils
    except ImportError as e:
        raise AsrError(f"dashscope SDK 不可用: {e}", code="config")

    model = model or DEFAULT_ASR_MODEL

    # 落一个临时文件供 SDK 上传（SDK 的上传接口只接受文件路径）
    suffix = os.path.splitext(filename)[1] or ".wav"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tf:
            tf.write(audio_bytes)
            tmp_path = tf.name

        try:
            uploaded = OssUtils.upload(model=model, file_path=tmp_path, api_key=api_key)
        except Exception as e:
            raise AsrError(f"上传音频到 DashScope 临时空间失败: {type(e).__name__}: {e}")
        # 不同 SDK 版本可能返回 str 或 (url, cert) 元组
        oss_url = uploaded[0] if isinstance(uploaded, (tuple, list)) else uploaded
        if not oss_url:
            raise AsrError("上传音频到 DashScope 临时空间失败：未返回 URL")

        call_kwargs = {
            "api_key": api_key,
            "model": model,
            "file_urls": [oss_url],
            "language_hints": ["zh", "en"],
            "diarization_enabled": True,
            "headers": {"X-DashScope-OssResourceResolve": "enable"},
        }
        if speaker_count:
            call_kwargs["speaker_count"] = speaker_count

        try:
            task = Transcription.async_call(**call_kwargs)
            result = Transcription.wait(task=task.output.task_id)
        except Exception as e:
            raise AsrError(f"调用 DashScope 转写失败: {type(e).__name__}: {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

    if result.status_code != HTTPStatus.OK:
        raise AsrError(
            f"DashScope 返回错误 status={result.status_code} code={result.code} "
            f"message={result.message}"
        )
    if result.output.task_status != "SUCCEEDED":
        raise AsrError(f"转写任务未成功: task_status={result.output.task_status}")

    # 任务成功但子任务可能失败，必须单独检查
    subtasks = result.output.results or []
    if not subtasks:
        raise AsrError("转写任务无结果")
    subtask = subtasks[0]
    if subtask.get("subtask_status") != "SUCCEEDED":
        raise AsrError(
            f"转写子任务失败: {subtask.get('code')} - {subtask.get('message')}"
        )

    transcription_url = subtask.get("transcription_url")
    if not transcription_url:
        raise AsrError("转写结果缺少 transcription_url")

    import requests
    try:
        data = requests.get(transcription_url, timeout=60).json()
    except Exception as e:
        raise AsrError(f"下载转写结果失败: {type(e).__name__}: {e}")

    transcripts = data.get("transcripts") or []
    if not transcripts:
        raise AsrError("转写结果为空")
    track = transcripts[0]

    sentences = [
        {
            "text": s.get("text", ""),
            "begin_time": s.get("begin_time"),
            "end_time": s.get("end_time"),
            "speaker_id": s.get("speaker_id"),
            "sentence_id": s.get("sentence_id"),
        }
        for s in (track.get("sentences") or [])
    ]

    return {
        "text": track.get("text", ""),
        "sentences": sentences,
        "model": model,
        "task_id": getattr(task.output, "task_id", None),
    }
