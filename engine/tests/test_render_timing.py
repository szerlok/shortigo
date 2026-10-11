"""The export guard must fail closed when media timing cannot be verified."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from clip_engine.services import rendering_service as module
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import build_layout_graph
from clip_engine.services.rendering_service import RenderingError, RenderingService


def stream(kind, start="0", duration="10"):
    return {"codec_type": kind, "start_time": start, "duration": duration}


@pytest.mark.parametrize("streams", [
    [], [stream("video")], [stream("audio")],
    [stream("video"), stream("audio", start="0.3")],
    [stream("video", start="0.066"), stream("audio")],
    [stream("video", duration="9"), stream("audio")],
    [stream("video"), stream("audio", duration="9")],
    [stream("video"), stream("audio", duration="nan")],
    [stream("video"), stream("audio", start="inf")],
    [stream("video"), {"codec_type": "audio"}],
    [stream("video"), stream("audio"), stream("audio")],
])
def test_rejects_unusable_exports(monkeypatch, streams):
    monkeypatch.setattr(module, "run_media", lambda *a, **kw: SimpleNamespace(
        returncode=0, stdout=json.dumps({"streams": streams}).encode(),
    ))
    service = RenderingService.__new__(RenderingService)
    with pytest.raises(RenderingError, match="timing validation failed"):
        asyncio.run(service._validate_output_timing("output.mp4", 10000, "30", True))


@pytest.mark.parametrize("with_audio,fps,video_duration,audio_duration", [
    (True, "30", "10", "10.020"), (False, "30", "10", "10"),
    (True, "30000/1001", "10.010", "10"),
    # Audio one frame short at the tail (seen on real 29.97 fps exports).
    (True, "30000/1001", "10", "9.967"),
])
def test_accepts_codec_and_frame_rounding(monkeypatch, with_audio, fps, video_duration, audio_duration):
    streams = [stream("video", duration=video_duration)]
    if with_audio:
        streams.append(stream("audio", duration=audio_duration))
    monkeypatch.setattr(module, "run_media", lambda *a, **kw: SimpleNamespace(
        returncode=0, stdout=json.dumps({"streams": streams}).encode(),
    ))
    service = RenderingService.__new__(RenderingService)
    asyncio.run(service._validate_output_timing("output.mp4", 10000, fps, with_audio))


def test_failed_probe_does_not_silently_drop_audio(monkeypatch):
    monkeypatch.setattr(module, "run_media", lambda *a, **kw: SimpleNamespace(returncode=1, stdout=b""))
    service = RenderingService.__new__(RenderingService)
    with pytest.raises(RenderingError, match="source audio"):
        asyncio.run(service._has_audio("source.mp4"))


@pytest.mark.parametrize("encoder_failure", [False, True])
def test_failed_export_is_removed_before_fallback(monkeypatch, tmp_path, encoder_failure):
    output = tmp_path / "clip.mp4"
    service = RenderingService.__new__(RenderingService)
    service._video_codec_args = lambda *a: []

    async def encode(_):
        output.write_bytes(b"broken media")
        if encoder_failure:
            raise RenderingError("FFmpeg failed")

    async def reject(*_):
        raise RenderingError("Export timing validation failed")

    monkeypatch.setattr(service, "_run_cmd", encode)
    monkeypatch.setattr(service, "_validate_output_timing", reject)
    with pytest.raises(RenderingError):
        asyncio.run(service._run_ffmpeg_complex("source.mp4", str(output), 0, 10000, "graph"))
    assert not output.exists()


def test_empty_edit_is_not_replaced_with_entire_source():
    plan = ClipLayoutPlan([ShotLayout(0, 1000, LayoutType.TALKING_HEAD)], 64, 64)
    with pytest.raises(ValueError, match="no video"):
        build_layout_graph(plan, 64, 64, keeps=[])
