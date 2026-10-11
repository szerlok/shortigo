"""Local range edits reuse saved transcription and never call an AI provider."""
import asyncio
import json
import math
import os
from pathlib import Path
import shutil
import sys

from clip_engine.config import CaptionStyle, get_settings
from clip_engine.services.rendering_service import RenderRequest, RenderingService
from clip_engine.services.title_overlay import export_title, probe
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord


def retain_edit_source(directory, source, request, rendered_clips, longform, captions_available):
    directory = Path(directory)
    destination = directory / ("source" + Path(source).suffix.lower())
    temporary = destination.with_suffix(destination.suffix + ".partial")
    config_path = directory / "editing.json"
    config_temp = directory / ".editing.json.partial"
    style = request.caption_style or CaptionStyle()
    config = {
        "version": 1,
        "source": destination.name,
        "settings": {
            "include_captions": request.include_captions and captions_available,
            "caption_style": {key: getattr(style, key) for key in CaptionStyle.__annotations__},
            "aspect_ratio": request.aspect_ratio,
            "layout_style": request.layout_style,
            "pacing": request.pacing,
            "remove_hesitations": request.remove_hesitations,
            "banner_platform": request.banner_platform,
            "banner_channel_url": request.banner_channel_url,
            "longform": longform,
        },
        # Index these after failed clips have been removed and survivors renumbered.
        "clips": {str(index): {
            "emphasis_words": segment.emphasis_words,
            "skip_ranges_ms": segment.skip_ranges_ms,
            "chapters": segment.chapters,
        } for index, (_, segment) in enumerate(rendered_clips)},
    }
    try:
        # Copy, never link to a mutable user-selected original.
        shutil.copy2(source, temporary)
        config_temp.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, destination)
        os.replace(config_temp, config_path)
    except BaseException:
        for path in (temporary, config_temp, destination, config_path):
            path.unlink(missing_ok=True)
        raise
    return destination.resolve().as_uri()


def validate_range(start, end, duration_ms):
    if (any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)
            for v in (start, end, duration_ms)) or
            start != int(start) or end != int(end) or start < 0 or
            end > duration_ms or end - start < 1000):
        raise ValueError("Invalid edit range")
    return int(start), int(end)


def restore_transcript(data, start, end):
    return [TranscriptSegment(
        start_time_ms=s["start_time_ms"], end_time_ms=s["end_time_ms"], text=s["text"],
        speaker_label=s.get("speaker_label"), audio_events=s.get("audio_events", []),
        words=[TranscriptWord(**w) for w in s.get("words", [])],
    ) for s in data["segments"] if s["end_time_ms"] > start and s["start_time_ms"] < end]


async def edit_range(request):
    directory = Path(request["directory"]).resolve(strict=True)
    def local(name):
        path = directory / name
        if path.resolve(strict=True).parent != directory or path.is_symlink():
            raise ValueError("Invalid editing artifact")
        return path
    config = json.loads(local("editing.json").read_text(encoding="utf-8"))
    if config.get("version") != 1:
        raise ValueError("Unsupported editing version")
    source = local(config["source"])
    if source != Path(request["source"]):
        raise ValueError("Editing source changed")
    width, height, seconds = await probe(source)
    transcript = json.loads(local("transcript.json").read_text(encoding="utf-8"))
    if request["action"] == "context":
        return {"source": str(source), "durationMs": math.floor(seconds * 1000),
                "segments": [{"startMs": s["start_time_ms"], "endMs": s["end_time_ms"],
                              "text": s["text"][:500]} for s in transcript["segments"][:20000]]}
    start, end = validate_range(request["startMs"], request["endMs"], math.floor(seconds * 1000))
    saved = config["settings"]
    segment = config["clips"][str(request["index"])]
    style = CaptionStyle()
    for key, value in saved["caption_style"].items():
        if key in CaptionStyle.__annotations__:
            setattr(style, key, value)
    # Force local heuristics even when the original job used paid vision.
    settings = get_settings()
    settings.layout_vision_enabled = False
    settings.openrouter_api_key = ""
    render = RenderingService()
    result = await render.render_clip(RenderRequest(
        video_path=str(source), output_path=request["base"],
        start_time_ms=start, end_time_ms=end, source_width=width, source_height=height,
        apply_padding=False,  # Respect the user's exact boundaries.
        transcript_segments=restore_transcript(transcript, start, end),
        include_captions=saved["include_captions"], caption_style=style,
        aspect_ratio=saved["aspect_ratio"], layout_style=saved["layout_style"],
        pacing=saved["pacing"], remove_hesitations=saved["remove_hesitations"],
        banner_platform=saved.get("banner_platform"), banner_channel_url=saved.get("banner_channel_url"),
        longform=saved["longform"], emphasis_words=segment["emphasis_words"],
        skip_ranges_ms=[(max(a, start), min(b, end)) for a, b in segment["skip_ranges_ms"] if b > start and a < end],
        chapters=[(t, title) for t, title in segment["chapters"] if start <= t < end],
    ))
    title = request["title"]
    await export_title(request["base"], request["destination"], title["text"], title["options"])
    return {
        "duration_ms": result.duration_ms, "layout_type": result.layout_type,
        "render_fallback": result.render_fallback, "removed_ms": result.removed_ms,
        "shots": result.layout_shots,
        "chapters": [{"time_ms": t, "title": title} for t, title in result.chapters] if len(result.chapters) >= 3 else None,
        "has_subtitles": bool(result.subtitle_path),
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(edit_range(json.loads(sys.stdin.read())))))
