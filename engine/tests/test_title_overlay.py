"""Title export checks use real media; no provider calls or API keys."""
import asyncio
import hashlib
import shutil
import subprocess

import pytest
from PIL import Image

from clip_engine.services.title_overlay import draw_title, export_title, options, probe, timing


@pytest.mark.parametrize("change", [{"end": float("nan")}, {"size": 1000}, {"color": "red;bad"}, {"enabled": "yes"}, {"mode": "range", "start": 4, "end": 2}])
def test_rejects_invalid_settings(change):
    with pytest.raises(ValueError):
        options(change)


@pytest.mark.parametrize("text", ["Żółć", "Zażółć gęślą jaźń — to znacznie więcej niż siedem słów w tytule", "W" * 240])
@pytest.mark.parametrize("font", ["montserrat", "poppins", "anton", "serif"])
def test_polish_and_long_titles_fit_canvas(text, font):
    image, y = draw_title(text, options({"font": font, "size": 100, "position": "manual", "y": 90}), 360, 640)
    assert image.width <= 360
    assert y + image.height <= 640
    assert image.getbbox()


def test_timing_uses_final_clip_clock():
    assert timing(options({"mode": "range", "start": 1, "end": 10, "fade": False}), 3) == (1, 3, 0)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg required")
def test_real_export_visibility_audio_duration_and_disable(tmp_path):
    base = tmp_path / "base.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=360x640:r=30:d=3",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(base)], check=True)
    digest = hashlib.sha256(base.read_bytes()).digest()
    target = tmp_path / "title.mp4"
    asyncio.run(export_title(base, target, "Żółć", options({"mode": "range", "start": 1, "end": 2, "fade": False})))
    assert abs(asyncio.run(probe(target))[2] - 3) < .1
    def pixel(at):
        png = tmp_path / f"frame{at}.png"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(at), "-i", str(target), "-frames:v", "1", str(png)], check=True)
        return Image.open(png).convert('RGB').getpixel((180, 42))
    assert pixel(.5)[2] > 180 and pixel(.5)[0] < 30
    assert pixel(1.5)[0] > 180
    assert pixel(2.5)[2] > 180 and pixel(2.5)[0] < 30
    audio = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(target)])
    assert b"aac" in audio
    disabled = tmp_path / "disabled.mp4"
    asyncio.run(export_title(base, disabled, "Inny tytuł", options({"enabled": False})))
    assert disabled.read_bytes() == base.read_bytes()
    assert hashlib.sha256(base.read_bytes()).digest() == digest


@pytest.mark.parametrize('background_music', [False, True])
def test_pipeline_preserves_title_free_base_after_cleanup(monkeypatch, tmp_path, background_music):
    from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
    from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment
    from clip_engine.services.transcription_service import TranscriptionResult, TranscriptSegment, TranscriptWord
    from clip_engine.config import get_settings
    from urllib.parse import urlparse, unquote
    import json
    from pathlib import Path

    settings = get_settings()
    monkeypatch.setattr(settings, 'local_mode', True)
    monkeypatch.setattr(settings, 'local_output_dir', str(tmp_path / 'library'))
    monkeypatch.setattr(settings.__class__, 'temp_directory', property(lambda self: str(tmp_path / 'work')))
    source = tmp_path / 'source.mp4'
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=4',
                    '-f', 'lavfi', '-i', 'sine=duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(source)], check=True)
    pipeline = AIClippingPipeline()
    async def transcript(**kwargs):
        return TranscriptionResult(segments=[TranscriptSegment(start_time_ms=0, end_time_ms=3000,
            text='Mówię po polsku.', words=[TranscriptWord(word='Mówię', start_time_ms=0, end_time_ms=1000),
            TranscriptWord(word='po', start_time_ms=1000, end_time_ms=1500), TranscriptWord(word='polsku.', start_time_ms=1500, end_time_ms=3000)])],
            full_text='Mówię po polsku.', language='pl', duration_seconds=4)
    async def plan(**kwargs):
        return ClipPlanResponse(segments=[ClipPlanSegment(start_time_ms=0, end_time_ms=3000, virality_score=.8, summary='Tytuł po polsku')])
    monkeypatch.setattr(pipeline.transcription_service, 'transcribe', transcript)
    monkeypatch.setattr(pipeline.intelligence_planner, 'plan_clips', plan)
    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url=str(source), job_id='title-test',
        background_music=background_music, layout_style='fill', pacing='natural', title_options=options({'mode': 'intro', 'end': 1}))))
    assert result.status == JobStatus.COMPLETED, result.error
    metadata = next((tmp_path / 'library').rglob('job_output.json'))
    data = json.loads(metadata.read_text())
    clip = data['clips'][0]
    base = Path(unquote(urlparse(clip['title_base_url']).path))
    final = Path(unquote(urlparse(clip['s3_url']).path))
    assert base.is_file() and final.is_file() and base != final
    assert base.read_bytes() != final.read_bytes()
    assert clip['title_edit']['text'] == 'Tytuł po polsku'
    assert not (tmp_path / 'work' / 'title-test').exists()
    assert source.exists()
    if background_music:
        dry = Path(unquote(urlparse(clip['music_base_url']).path))
        assert dry.is_file() and dry != final and dry != base
        assert clip['music_edit']['enabled'] is True
    else:
        assert clip['music_edit'] is None and clip['music_base_url'] is None
