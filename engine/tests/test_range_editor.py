"""Focused offline checks: optional source copy, bounds, and reuse without AI."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from clip_engine.config import CaptionStyle
from clip_engine.services import range_editor as editor
from clip_engine.services.ai_clipping_pipeline import ClippingJobRequest
from clip_engine.services.rendering_service import RenderResult


def prepare(tmp_path):
    source = tmp_path / 'input.mp4'
    source.write_bytes(b'original')
    output = tmp_path / 'run'
    output.mkdir()
    style = CaptionStyle()
    style.font_size = 63
    request = ClippingJobRequest(video_url=str(source), caption_style=style, remove_hesitations=True)
    segment = SimpleNamespace(emphasis_words=['działa'], skip_ranges_ms=[(7000, 9000)], chapters=[])
    editor.retain_edit_source(output, source, request, [('clip.mp4', segment)], False, True)
    (output / 'transcript.json').write_text(json.dumps({'segments': [
        {'start_time_ms': 500, 'end_time_ms': 2800, 'text': 'Przed klipem', 'words': [
            {'word': 'Przed', 'start_time_ms': 500, 'end_time_ms': 1400}]},
        {'start_time_ms': 3000, 'end_time_ms': 9500, 'text': 'To działa', 'words': []},
    ]}))
    return source, output


def test_retention_is_optional_and_is_an_independent_copy(tmp_path):
    assert ClippingJobRequest(video_url='x').retain_source is False
    source, output = prepare(tmp_path)
    source.write_bytes(b'changed')
    assert (output / 'source.mp4').read_bytes() == b'original'
    saved = json.loads((output / 'editing.json').read_text())
    assert saved['settings']['caption_style']['font_size'] == 63
    assert saved['settings']['caption_style']['primary_color'] == CaptionStyle.primary_color
    assert saved['settings']['remove_hesitations'] is True
    assert '0' in saved['clips']


def test_range_bounds():
    assert editor.validate_range(0, 1000, 1000) == (0, 1000)
    for start, end in [(-1, 1000), (1000, 1000), (0, 999), (0, 5001), (True, 2000), (0.5, 2000), (0, float('nan'))]:
        with pytest.raises(ValueError):
            editor.validate_range(start, end, 5000)


def test_reedit_reuses_transcript_and_settings_without_paid_vision(tmp_path, monkeypatch):
    _, output = prepare(tmp_path)
    settings = SimpleNamespace(layout_vision_enabled=True, openrouter_api_key='test-only')
    monkeypatch.setattr(editor, 'get_settings', lambda: settings)
    async def probe(_):
        return 1920, 1080, 10.0
    monkeypatch.setattr(editor, 'probe', probe)
    captured = []
    class Renderer:
        async def render_clip(self, request):
            assert settings.layout_vision_enabled is False
            assert settings.openrouter_api_key == ''
            captured.append(request)
            return RenderResult(request.output_path, 100, 6800)
    monkeypatch.setattr(editor, 'RenderingService', Renderer)
    titles = []
    async def title(*args):
        titles.append(args)
    monkeypatch.setattr(editor, 'export_title', title)
    request = {'action': 'export', 'directory': str(output), 'source': str(output / 'source.mp4'),
               'index': 0, 'startMs': 1000, 'endMs': 8000, 'base': str(output / 'new.base.mp4'),
               'destination': str(output / 'new.mp4'), 'title': {'text': 'Zmieniony tytuł', 'options': {'enabled': False}}}
    result = asyncio.run(editor.edit_range(request))
    render = captured[0]
    assert (render.start_time_ms, render.end_time_ms) == (1000, 8000)
    assert render.apply_padding is False
    assert render.caption_style.font_size == 63
    assert render.remove_hesitations is True
    assert [s.text for s in render.transcript_segments] == ['Przed klipem', 'To działa']
    assert render.skip_ranges_ms == [(7000, 8000)]
    assert titles[0][2] == 'Zmieniony tytuł'
    assert result['duration_ms'] == 6800
    # Reading context must never instantiate the renderer.
    request['action'] = 'context'
    result = asyncio.run(editor.edit_range(request))
    assert len(captured) == 1
    assert result['durationMs'] == 10000
    # A saved config cannot replace the source authorized by the app.
    request['source'] = str(tmp_path / 'input.mp4')
    with pytest.raises(ValueError, match='source changed'):
        asyncio.run(editor.edit_range(request))
