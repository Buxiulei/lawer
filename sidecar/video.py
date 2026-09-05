#!/usr/bin/env python3
"""
视频提取 —— 用系统 ffmpeg / ffprobe 抽音轨与关键帧

上层用途：一段录像（约谈录像、现场视频）先在这里拆成
「16k 单声道 wav」+「若干张关键帧 JPEG」，wav 交 /asr 转写、帧交 /ocr 认字。
本模块**只做拆解**，不调任何云服务、不落库、不留临时文件
（一切都在 TemporaryDirectory 里，请求结束即删）。

采样率与声道数是硬约束不是偏好：DashScope Paraformer 的说话人分离**只支持单声道**
（见 asr.py 头部），而 16k 是 paraformer-v2 的目标采样率。这里转好，
上层就不必再判断「这段音是不是分不了人」。

不引入 Python 侧的重依赖（av / moviepy / opencv 一个都不装）：
ffmpeg 本来就是部署环境要装的系统包，subprocess 调它足够，
多一层 Python 绑定只是多一份要跟着 ffmpeg 版本走的编译依赖。

env：
  VIDEO_MAX_BYTES          上传体积上限，默认 200MB
  VIDEO_MAX_SECONDS        时长上限，默认 3600 秒（60 分钟）
  VIDEO_FFMPEG_TIMEOUT_S   单次 ffmpeg/ffprobe 调用超时，默认 600 秒
"""

import base64
import json
import os
import shutil
import subprocess
import tempfile

VIDEO_MAX_BYTES = int(os.environ.get("VIDEO_MAX_BYTES", str(200 * 1024 * 1024)))
VIDEO_MAX_SECONDS = float(os.environ.get("VIDEO_MAX_SECONDS", "3600"))
FFMPEG_TIMEOUT_S = int(os.environ.get("VIDEO_FFMPEG_TIMEOUT_S", "600"))

DEFAULT_MAX_FRAMES = 12
DEFAULT_FRAME_INTERVAL_S = 10.0

# /asr 与 paraformer 的硬约束，改这两个数等于让转写结果悄悄退化（说话人分离失效）
AUDIO_SAMPLE_RATE = 16000
AUDIO_CHANNELS = 1

_READ_CHUNK = 1024 * 1024


class VideoError(Exception):
    """视频提取失败。

    code 决定 HTTP 状态（main.py 的 _ERR_STATUS）：
      config   缺 ffmpeg 之类的环境问题  → 503
      input    文件坏了 / 参数不合法      → 400
      limit    超体积或超时长上限        → 413
      upstream ffmpeg 跑挂了或超时       → 502
    """

    def __init__(self, message: str, code: str = "input"):
        super().__init__(message)
        self.code = code


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise VideoError(
            f"缺 {name}：视频抽音轨与关键帧依赖系统的 ffmpeg/ffprobe，"
            f"当前 PATH 上找不到 {name}；"
            "请在运行环境安装 ffmpeg（Debian/Ubuntu: apt-get install -y ffmpeg）后重启 sidecar。",
            code="config",
        )
    return path


def _run(argv: list) -> str:
    """跑一条 ffmpeg/ffprobe，返回 stdout。非零退出与超时都抛 VideoError。"""
    try:
        p = subprocess.run(
            argv, capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=False
        )
    except subprocess.TimeoutExpired:
        raise VideoError(
            f"{os.path.basename(argv[0])} 超时（>{FFMPEG_TIMEOUT_S}s）：文件可能过大或已损坏",
            code="upstream",
        )
    if p.returncode != 0:
        tail = (p.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        # 坏文件是最常见的失败因，属于调用方的输入问题，不是 sidecar 内部错误
        raise VideoError(
            f"{os.path.basename(argv[0])} 处理失败: {tail[-1] if tail else '无输出'}",
            code="input",
        )
    return p.stdout.decode("utf-8", "replace")


def _spool(stream, dst_path: str) -> int:
    """把上传流分块落到临时文件，边写边数字节；超上限立刻中止（不把整个文件读进内存）。"""
    total = 0
    with open(dst_path, "wb") as f:
        while True:
            chunk = stream.read(_READ_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > VIDEO_MAX_BYTES:
                raise VideoError(
                    f"视频体积超过上限 {VIDEO_MAX_BYTES} 字节（{VIDEO_MAX_BYTES // 1024 // 1024}MB），"
                    "请先裁剪或压缩后再上传",
                    code="limit",
                )
            f.write(chunk)
    if total == 0:
        raise VideoError("上传文件为空", code="input")
    return total


def _probe(ffprobe: str, path: str) -> dict:
    raw = _run([
        ffprobe, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ])
    try:
        data = json.loads(raw)
    except ValueError:
        raise VideoError("ffprobe 输出无法解析，文件可能不是音视频", code="input")

    streams = data.get("streams") or []
    vs = next((s for s in streams if s.get("codec_type") == "video"), None)
    as_ = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if vs is None and as_ is None:
        raise VideoError("文件里没有可用的视频或音频轨", code="input")

    duration = 0.0
    for candidate in ((data.get("format") or {}).get("duration"),
                      (vs or {}).get("duration"), (as_ or {}).get("duration")):
        try:
            duration = float(candidate)
        except (TypeError, ValueError):
            continue
        if duration > 0:
            break
    if duration <= 0:
        raise VideoError("读不出视频时长，无法按时间抽帧", code="input")

    return {
        "duration_s": duration,
        "has_video": vs is not None,
        "has_audio": as_ is not None,
        "probe": {
            "width": vs.get("width") if vs else None,
            "height": vs.get("height") if vs else None,
            "codec": (vs or as_ or {}).get("codec_name"),
        },
    }


def frame_times(duration_s: float, max_frames: int, frame_interval_s: float) -> list:
    """算出要抽帧的时间点。

    间隔够稀（帧数不超上限）就按间隔走；长视频（按间隔会超上限）改为在全片上**均匀**采样
    max_frames 个点——否则一小时的录像按 10 秒一帧只会取到开头两分钟，
    等于把「这段视频讲了什么」误答成「这段视频开头讲了什么」。
    """
    if duration_s <= 0 or max_frames <= 0 or frame_interval_s <= 0:
        return []
    by_interval = int(duration_s // frame_interval_s) + 1
    if by_interval <= max_frames:
        times = [i * frame_interval_s for i in range(by_interval)]
    else:
        step = duration_s / max_frames
        times = [i * step for i in range(max_frames)]
    return [round(t, 3) for t in times if t < duration_s]


def _extract_audio(ffmpeg: str, src: str, dst: str) -> bool:
    """抽 16k 单声道 PCM wav。无音轨返回 False。"""
    _run([
        ffmpeg, "-nostdin", "-v", "error", "-y",
        "-i", src,
        "-vn", "-map", "0:a:0",
        "-ac", str(AUDIO_CHANNELS), "-ar", str(AUDIO_SAMPLE_RATE),
        "-c:a", "pcm_s16le", "-f", "wav", dst,
    ])
    return os.path.exists(dst) and os.path.getsize(dst) > 0


def _extract_frame(ffmpeg: str, src: str, dst: str, t: float) -> bool:
    """抽 t 秒处的一帧 JPEG。-ss 放在 -i 之前是输入侧快速定位，落到该时刻之前最近的关键帧。"""
    _run([
        ffmpeg, "-nostdin", "-v", "error", "-y",
        "-ss", f"{t:.3f}", "-i", src,
        "-frames:v", "1", "-q:v", "3", "-f", "image2", dst,
    ])
    return os.path.exists(dst) and os.path.getsize(dst) > 0


def extract_video(stream, max_frames: int = DEFAULT_MAX_FRAMES,
                  frame_interval_s: float = DEFAULT_FRAME_INTERVAL_S) -> dict:
    """从上传流里抽音轨与关键帧。

    返回 {duration_s, audio_wav_b64, frames:[{t_s, jpeg_b64}], probe:{width,height,codec}}；
    无音轨时 audio_wav_b64 为 None，无视频轨时 frames 为空。失败抛 VideoError。
    """
    ffmpeg = _tool("ffmpeg")
    ffprobe = _tool("ffprobe")

    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "in")
        size = _spool(stream, src)

        info = _probe(ffprobe, src)
        duration = info["duration_s"]
        if duration > VIDEO_MAX_SECONDS:
            raise VideoError(
                f"视频时长 {duration:.1f} 秒超过上限 {VIDEO_MAX_SECONDS:.0f} 秒"
                f"（{VIDEO_MAX_SECONDS / 60:.0f} 分钟），请先裁剪出要提取的片段",
                code="limit",
            )

        audio_b64 = None
        if info["has_audio"]:
            wav = os.path.join(td, "audio.wav")
            if _extract_audio(ffmpeg, src, wav):
                with open(wav, "rb") as f:
                    audio_b64 = base64.b64encode(f.read()).decode("ascii")

        frames = []
        if info["has_video"]:
            for i, t in enumerate(frame_times(duration, max_frames, frame_interval_s)):
                jpg = os.path.join(td, f"f{i}.jpg")
                if not _extract_frame(ffmpeg, src, jpg, t):
                    continue
                with open(jpg, "rb") as f:
                    frames.append({
                        "t_s": t,
                        "jpeg_b64": base64.b64encode(f.read()).decode("ascii"),
                    })

    return {
        "duration_s": round(duration, 3),
        "size_bytes": size,
        "audio_wav_b64": audio_b64,
        "audio_sample_rate": AUDIO_SAMPLE_RATE if audio_b64 else None,
        "audio_channels": AUDIO_CHANNELS if audio_b64 else None,
        "frames": frames,
        "probe": info["probe"],
    }


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("用法: python3 video.py <视频文件> [max_frames] [frame_interval_s]")
        raise SystemExit(2)
    with open(sys.argv[1], "rb") as fh:
        r = extract_video(
            fh,
            int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MAX_FRAMES,
            float(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_FRAME_INTERVAL_S,
        )
    r["audio_wav_b64"] = f"<{len(r['audio_wav_b64'] or '')} chars>"
    r["frames"] = [{"t_s": f["t_s"], "jpeg_b64": f"<{len(f['jpeg_b64'])} chars>"} for f in r["frames"]]
    print(json.dumps(r, ensure_ascii=False, indent=2))
