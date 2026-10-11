#!/usr/bin/env python3
"""
BridgeClip Bridge Runner

Thin bridge between Electron and BridgeClip clipping engine.
Accepts a JSON config on stdin, runs the pipeline in LOCAL_MODE,
and streams structured JSON-line progress to stdout for Electron to consume.

Usage:
    python bridge_runner.py < job-config.json
"""

import asyncio
import json
import logging
import os
import sys
import time
import re
from urllib.parse import urlsplit

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("bridge_runner")

# Protocol stream set by reserve_stdout_for_protocol(); tests use sys.stdout.
_protocol = None

# Mirrors DURATION_OPTIONS in src/shared/job-contract.ts.
DURATION_RANGE_IDS = ("xshort", "short", "medium", "long", "xlong", "extended", "feature")

# Known failure classes -> (message, hint). Raw engine errors can contain
# request URLs, proxy credentials and local paths, so only these fixed strings
# reach the UI. First match wins.
FAILURES = (
    (("not enough disk space to save clips",),
     "Brakuje wolnego miejsca na dysku, aby ukończyć ten film.",
     "Zwolnij miejsce na dysku systemowym i dysku zapisu. Filmy źródłowe mogą zajmować kilka GB podczas przetwarzania."),
    (("transcription authentication failed",),
     "OpenRouter odrzucił żądanie transkrypcji.",
     "Sprawdź klucz API OpenRouter w ustawieniach."),
    (("transcription quota or rate limit reached",),
     "OpenRouter nie mógł utworzyć transkrypcji z powodu limitu zapytań lub środków.",
     "Sprawdź konto OpenRouter i spróbuj później."),
    (("transcription service unavailable",),
     "Nie udało się połączyć z OpenRouter w celu transkrypcji.",
     "Sprawdź połączenie i spróbuj ponownie."),
    (("transcription request rejected by provider",),
     "OpenRouter odrzucił dźwięk przesłany do transkrypcji.",
     "OpenRouter odrzucił format dźwięku lub opcje żądania. Zaktualizuj BridgeClip i spróbuj ponownie. Jeśli problem się powtórzy, zgłoś zadanie."),
    (("transcription response lacked word timestamps",),
     "OpenRouter zwrócił transkrypcję bez czasów poszczególnych słów.",
     "Ponów zadanie. Jeśli problem się powtórzy, zgłoś je, aby można było sprawdzić odpowiedź dostawcy."),
    (("transcription response was invalid", "transcription response was too large"),
     "OpenRouter zwrócił nieprawidłową transkrypcję.",
     "Ponów zadanie. Jeśli problem się powtórzy, zgłoś je, aby można było sprawdzić odpowiedź dostawcy."),
    (("audio extraction failed", "audio duration could not be determined", "transcription audio preparation failed"),
     "BridgeClip nie mógł przygotować dźwięku do transkrypcji.",
     "Uruchom Ustawienia → Sprawdzenie systemu. Jeśli narzędzia są gotowe, zgłoś zadanie z kodem błędu."),
    (("transcription audio chunk exceeded the size limit",),
     "Dźwięk do transkrypcji przekroczył limit rozmiaru BridgeClip.",
     "Wybierz krótszy fragment filmu lub zgłoś zadanie, aby można było dostosować rozmiar części."),
    (("transcription failed",),
     "Transkrypcja dźwięku nie powiodła się.",
     "Sprawdź, czy film ma działającą ścieżkę dźwiękową, i spróbuj ponownie."),
    (("video render failed",),
     "Renderowanie klipów nie powiodło się.",
     "Uruchom Ustawienia → Sprawdzenie systemu. Jeśli narzędzia są gotowe, zgłoś zadanie do sprawdzenia."),
    (("http error 403", "sign in to confirm", "blocking this request"),
     "YouTube odmówił pobrania filmu.",
     "Zaktualizuj BridgeClip i spróbuj ponownie. Jeśli problem pozostanie, pobierz film samodzielnie i dodaj go jako plik lokalny."),
    (("video unavailable", "private video", "members-only", "has been removed", "not available in your country"),
     "Film jest prywatny, usunięty lub niedostępny w Twoim regionie.",
     "Sprawdź link w przeglądarce bez logowania lub użyj pliku lokalnego."),
    (("exceeds maximum allowed duration",),
     "Film przekracza maksymalną obsługiwaną długość.",
     "Ustaw początek i koniec, aby przetworzyć fragment filmu."),
    (("no clip-worthy moments",),
     "BridgeClip nie znalazł fragmentów do utworzenia klipów.",
     "Nie znaleziono wyraźnych wypowiedzi lub scen pasujących do wybranej długości. Poszerz zakres filmu lub wybierz krótsze klipy."),
    (("out of credits", "quota exceeded"),
     "Brakuje środków dla klucza OpenRouter.",
     "Doładuj środki na openrouter.ai/credits lub zwiększ limit klucza na openrouter.ai/keys."),
    (("(401)", "status_code: 401", "unauthorized", "invalid api key", "invalid_api_key"),
     "Klucz API został odrzucony.",
     "Sprawdź klucz OpenRouter w ustawieniach."),
    (("timed out", "connection", "name resolution", "network is unreachable"),
     "Żądanie sieciowe nie powiodło się.",
     "Sprawdź połączenie z internetem i spróbuj ponownie."),
    (("video download failed",),
     "Nie udało się pobrać filmu.",
     "Sprawdź link w przeglądarce i połączenie z internetem. Możesz też użyć pliku lokalnego."),
)


def describe_failure(error: object) -> dict:
    """Map an engine error to a safe, actionable message and hint."""
    text = str(error or "").lower()
    for markers, message, hint in FAILURES:
        if any(marker in text for marker in markers):
            return {"message": message, "hint": hint}
    return {"message": "Tworzenie klipów nie powiodło się.", "hint": "Sprawdź system i spróbuj ponownie. Jeśli problem pozostanie, zgłoś kroki prowadzące do błędu."}


def reserve_stdout_for_protocol() -> None:
    """Keep stdout for JSON lines and send all other output to stderr.

    yt-dlp progress bars and FFmpeg children write to stdout. A partial line
    (no newline) glues itself to the next JSON message, and Electron then
    drops that message as non-JSON.
    """
    global _protocol
    _protocol = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)


def emit(msg: dict) -> None:
    """Write a JSON line to the protocol stream for Electron to read."""
    stream = _protocol or sys.stdout
    stream.write(json.dumps(msg) + "\n")
    stream.flush()


def progress_callback(progress) -> None:
    """Forward pipeline progress as JSON-line."""
    emit({
        "type": "progress",
        "status": progress.status.value if hasattr(progress.status, 'value') else str(progress.status),
        "percent": progress.progress_percent,
        "step": progress.current_step,
        "clips_done": progress.clips_completed,
        "clips_total": progress.total_clips,
    })


async def run(config: dict) -> bool:
    """Run the clipping pipeline with the given config."""
    config = validate_config(config)
    # Configure before BridgeClip imports: settings are cached by the engine.
    os.environ["LOCAL_MODE"] = "true"
    if config.get("output_dir"):
        os.environ["LOCAL_OUTPUT_DIR"] = config["output_dir"]
    # Downloads use the user's own connection. A developer's BridgeClip .env can
    # hold the server's proxy pool, and environment variables beat .env values.
    os.environ["YTDLP_PROXIES"] = ""
    os.environ["YTDLP_PROXY"] = ""
    os.environ["LAYOUT_VISION_ENABLED"] = "true" if config["layout_vision_enabled"] else "false"

    from network_guard import install as install_network_guard
    install_network_guard()

    from clip_engine.logging_safety import install_safe_logging
    install_safe_logging()

    from clip_engine.bridge_contract import BRIDGE_CONTRACT_VERSION
    if config["contract_version"] != BRIDGE_CONTRACT_VERSION:
        emit({"type": "error", "message": "Silnik tworzenia klipów jest niezgodny z tą wersją BridgeClip."})
        return False

    from clip_engine.config import get_settings, get_caption_preset
    from clip_engine.services.ai_clipping_pipeline import (
        AIClippingPipeline,
        ClippingJobRequest,
        JobStatus,
    )

    settings = get_settings()

    missing = []
    if not settings.openrouter_api_key:
        missing.append("OPENROUTER_API_KEY")
    if missing:
        emit({"type": "error", "message": f"Brakuje wymaganych kluczy API: {', '.join(missing)}"})
        return False

    caption_style = None
    preset_name = config.get("caption_preset", "pop")
    if config.get("include_captions", True):
        try:
            caption_style = get_caption_preset(preset_name)
        except ValueError:
            try:
                caption_style = get_caption_preset("pop")
            except ValueError:
                pass

    duration_ranges = config.get("duration_ranges")

    video_source = config.get("video_url", "")
    if os.path.isfile(video_source):
        video_source = os.path.abspath(video_source)

    request = ClippingJobRequest(
        video_url=video_source,
        job_id=config.get("job_id"),
        max_clips=config.get("max_clips"),
        auto_clip_count=config.get("auto_clip_count", True),
        duration_ranges=duration_ranges,
        aspect_ratio=config.get("aspect_ratio", "9:16"),
        layout_style=config.get("layout_style") or "auto",
        pacing=config.get("pacing") or "tight",
        retain_source=config.get("retain_source", False),
        remove_hesitations=config.get("remove_hesitations", False),
        background_music=config.get("background_music", False),
        stronger_hook=config.get("stronger_hook", False),
        include_captions=config.get("include_captions", True),
        caption_style=caption_style,
        title_options=config.get("title_options"),
        start_time_seconds=config.get("start_time_seconds"),
        end_time_seconds=config.get("end_time_seconds"),
        banner_platform=config.get("banner_platform"),
        banner_channel_url=config.get("banner_channel_url"),
        keyterms=config.get("keyterms") or None,
    )

    emit({
        "type": "progress",
        "status": "pending",
        "percent": 0,
        "step": "Starting pipeline...",
        "clips_done": 0,
        "clips_total": 0,
    })

    pipeline = AIClippingPipeline(progress_callback=progress_callback)
    start = time.monotonic()
    result = await pipeline.process_video(request)
    elapsed = time.monotonic() - start

    if result.status == JobStatus.COMPLETED and result.output:
        from dataclasses import asdict
        output_data = asdict(result.output)
        emit({
            "type": "result",
            "status": "completed",
            "job_id": result.job_id,
            "processing_time_seconds": elapsed,
            "output": output_data,
        })
        return True
    failure_code = getattr(result, "failure_code", None)
    failure_stage = getattr(result, "failure_stage", None)
    http_status = getattr(result, "http_status", None)
    diagnostic = {}
    if isinstance(failure_code, str) and re.fullmatch(r"[a-z]+(?:[._][a-z]+)*", failure_code) and len(failure_code) <= 64:
        diagnostic["code"] = failure_code
    if failure_stage in {"setup", "download", "transcription", "planning", "rendering", "saving", "uploading"}:
        diagnostic["stage"] = failure_stage
    if type(http_status) is int and 100 <= http_status <= 599:
        diagnostic["http_status"] = http_status
    emit({"type": "error", **describe_failure(result.error), **diagnostic})
    return False


def validate_config(config: object) -> dict:
    """Reject malformed bridge requests before loading the engine or writing files."""
    if not isinstance(config, dict):
        raise ValueError("Config must be a JSON object")
    if type(config.get("contract_version")) is not int or config["contract_version"] != 1:
        raise ValueError("Unsupported clipping engine contract version")
    if type(config.get("layout_vision_enabled")) is not bool:
        raise ValueError("layout_vision_enabled must be a boolean")
    job_id = config.get("job_id")
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job_id):
        raise ValueError("A valid job_id is required")
    source = config.get("video_url")
    if not isinstance(source, str) or not source.strip() or len(source) > 8192:
        raise ValueError("A video source is required")
    if not os.path.isfile(source):
        try:
            url = urlsplit(source)
            if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password:
                raise ValueError()
        except ValueError:
            raise ValueError("Video source must be a local file or HTTP(S) URL") from None
    output = config.get("output_dir")
    if output is not None and (not isinstance(output, str) or not os.path.isabs(output) or "\0" in output):
        raise ValueError("Output directory must be an absolute path")
    for field in ("include_captions", "auto_clip_count", "layout_vision_enabled", "remove_hesitations", "retain_source", "stronger_hook", "background_music"):
        if field in config and not isinstance(config[field], bool):
            raise ValueError(f"{field} must be a boolean")
    count = config.get("max_clips")
    if count is not None and (type(count) is not int or not 1 <= count <= 100):
        raise ValueError("max_clips must be between 1 and 100")
    if config.get("aspect_ratio", "9:16") not in ("9:16", "16:9"):
        raise ValueError("Invalid aspect ratio")
    if config.get("layout_style", "auto") not in ("auto", "fill", "fit"):
        raise ValueError("Invalid layout style")
    if config.get("pacing", "tight") not in ("tight", "natural"):
        raise ValueError("Invalid pacing")
    keyterms = config.get("keyterms")
    if keyterms is not None and (
        not isinstance(keyterms, list) or len(keyterms) > 1000 or
        any(not isinstance(term, str) or not term.strip() or len(term) > 49 for term in keyterms)
    ):
        raise ValueError("Invalid keyterms")
    ranges = config.get("duration_ranges")
    if ranges is not None and (
        not isinstance(ranges, list) or len(ranges) > len(DURATION_RANGE_IDS) or
        any(item not in DURATION_RANGE_IDS for item in ranges)
    ):
        raise ValueError("Invalid clip duration")
    return config


def main() -> int:
    if len(sys.argv) > 2:
        emit({"type": "error", "message": "Przekaż konfigurację JSON na wejściu standardowym."})
        return 1
    try:
        # Legacy CLI argument remains accepted; Electron uses stdin to keep
        # private source URLs out of process listings. Bound either transport.
        raw = sys.argv[1] if len(sys.argv) == 2 else sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValueError("Config too large")
        config = validate_config(json.loads(raw))
    except (ValueError, TypeError):
        emit({"type": "error", "message": "Nieprawidłowa konfiguracja tworzenia klipów."})
        return 1
    try:
        return 0 if asyncio.run(run(config)) else 1
    except KeyboardInterrupt:
        emit({"type": "error", "message": "Tworzenie klipów anulowane przez użytkownika"})
        return 130
    except Exception as error:
        # Provider exceptions can include request URLs, credentials and local paths.
        logger.error("Bridge runner failed (%s)", type(error).__name__)
        emit({"type": "error", "message": "Wystąpił błąd silnika. Sprawdź konfigurację i spróbuj ponownie."})
        return 1


if __name__ == "__main__":
    reserve_stdout_for_protocol()
    sys.exit(main())
