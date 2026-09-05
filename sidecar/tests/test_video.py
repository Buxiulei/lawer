"""/video 端点单测（全离线，用 ffmpeg 现场合成测试视频）。

运行: .venv/bin/python -m pytest tests -q

没装 ffmpeg 的机器上，需要真跑 ffmpeg 的用例整体 skip 并说明原因；
纯函数（frame_times）与「缺 ffmpeg 应 503」两条不依赖 ffmpeg，任何机器都跑。
"""

import io
import os
import shutil
import subprocess
import sys
import wave

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main  # noqa: E402
import video  # noqa: E402

client = TestClient(main.app)

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
needs_ffmpeg = pytest.mark.skipif(
    not HAS_FFMPEG,
    reason="本机 PATH 上没有 ffmpeg/ffprobe，无法现场合成测试视频；装 ffmpeg 后这些用例才有意义",
)

CLIP_SECONDS = 5


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    """现场合成一段 5 秒测试视频：testsrc 彩条 + 440Hz 正弦音，mpeg4 + aac。

    编码器选 mpeg4/aac 而非 libx264：这两个是 ffmpeg 内置的，
    不依赖发行版有没有编进 libx264，测试不该因为构建选项而变红。
    """
    path = tmp_path_factory.mktemp("video") / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg", "-nostdin", "-v", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=320x240:rate=25:duration={CLIP_SECONDS}",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={CLIP_SECONDS}",
            "-c:v", "mpeg4", "-c:a", "aac", "-t", str(CLIP_SECONDS), "-shortest",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path.read_bytes()


def _post(clip_bytes, **data):
    return client.post(
        "/video",
        files={"file": ("clip.mp4", io.BytesIO(clip_bytes), "video/mp4")},
        data=data,
    )


# ---------------- 纯函数：抽帧时间点 ----------------

def test_frame_times_follows_interval_when_under_cap():
    assert video.frame_times(50.0, 12, 10.0) == [0.0, 10.0, 20.0, 30.0, 40.0]


def test_frame_times_caps_and_spreads_over_whole_clip():
    """长视频：帧数必须 ≤ max_frames，且最后一帧要落在后半段（不是只取开头）。"""
    ts = video.frame_times(3600.0, 12, 10.0)
    assert len(ts) == 12
    assert ts[0] == 0.0
    assert ts[-1] > 1800.0
    assert ts[-1] < 3600.0


def test_frame_times_never_lands_on_or_past_the_end():
    assert all(t < 5.0 for t in video.frame_times(5.0, 12, 1.0))


# ---------------- 端到端 ----------------

@needs_ffmpeg
def test_video_end_to_end(clip):
    r = _post(clip, max_frames=12, frame_interval_s=1)
    assert r.status_code == 200, r.text
    body = r.json()

    assert abs(body["duration_s"] - CLIP_SECONDS) < 0.5
    assert body["probe"] == {"width": 320, "height": 240, "codec": "mpeg4"}

    # 每个计划抽的时间点都真抽出了帧
    planned = video.frame_times(body["duration_s"], 12, 1.0)
    assert len(body["frames"]) == len(planned)
    assert [f["t_s"] for f in body["frames"]] == planned
    for f in body["frames"]:
        jpeg = _b64(f["jpeg_b64"])
        assert jpeg[:3] == b"\xff\xd8\xff"  # JPEG SOI

    # 音轨必须是 16k 单声道 16bit —— paraformer 的说话人分离只吃单声道
    with wave.open(io.BytesIO(_b64(body["audio_wav_b64"])), "rb") as w:
        assert w.getframerate() == 16000
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert abs(w.getnframes() / 16000 - CLIP_SECONDS) < 0.5
    assert body["audio_sample_rate"] == 16000
    assert body["audio_channels"] == 1


@needs_ffmpeg
def test_max_frames_is_a_hard_cap(clip):
    """5 秒视频按 1 秒一帧本该 5 张，max_frames=3 时必须只回 3 张，且铺满全片。"""
    r = _post(clip, max_frames=3, frame_interval_s=1)
    assert r.status_code == 200, r.text
    frames = r.json()["frames"]
    assert len(frames) == 3
    assert frames[-1]["t_s"] > CLIP_SECONDS / 2


@needs_ffmpeg
def test_default_interval_yields_one_frame_for_short_clip(clip):
    """默认 frame_interval_s=10：5 秒的片子只该有开头一帧。"""
    r = _post(clip)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [f["t_s"] for f in body["frames"]] == [0.0]


# ---------------- 上限与坏输入 ----------------

@needs_ffmpeg
def test_oversize_bytes_413(clip, monkeypatch):
    monkeypatch.setattr(video, "VIDEO_MAX_BYTES", 1024)
    r = _post(clip)
    assert r.status_code == 413
    assert "上限" in r.json()["detail"]


@needs_ffmpeg
def test_over_duration_413(clip, monkeypatch):
    monkeypatch.setattr(video, "VIDEO_MAX_SECONDS", 1.0)
    r = _post(clip)
    assert r.status_code == 413
    assert "时长" in r.json()["detail"]


@needs_ffmpeg
def test_garbage_file_is_4xx_not_500():
    r = client.post(
        "/video",
        files={"file": ("fake.mp4", io.BytesIO(b"this is not a video" * 500), "video/mp4")},
    )
    assert 400 <= r.status_code < 500, f"坏文件应判 4xx，实际 {r.status_code}: {r.text}"


@needs_ffmpeg
def test_empty_file_400():
    r = client.post("/video", files={"file": ("empty.mp4", io.BytesIO(b""), "video/mp4")})
    assert r.status_code == 400


def test_max_frames_out_of_range_422():
    r = client.post(
        "/video",
        files={"file": ("clip.mp4", io.BytesIO(b"x"), "video/mp4")},
        data={"max_frames": 0},
    )
    assert r.status_code == 422


def test_missing_ffmpeg_503(monkeypatch):
    """缺 ffmpeg 要自述缺什么、为什么缺、怎么办，而不是裸崩。"""
    monkeypatch.setattr(video.shutil, "which", lambda name: None)
    r = client.post("/video", files={"file": ("clip.mp4", io.BytesIO(b"xx"), "video/mp4")})
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert "缺 ffmpeg" in detail
    assert "apt-get install" in detail


def _b64(s):
    import base64

    assert s, "期望有内容，实际是空的"
    return base64.b64decode(s)
