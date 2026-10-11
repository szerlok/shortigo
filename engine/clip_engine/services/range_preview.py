"""Browser-compatible local preview; source and export quality stay untouched."""
import asyncio
import json
import os
from pathlib import Path
import sys
import uuid

from clip_engine.services.title_overlay import probe


def preview_command(source, destination):
    return [
        "ffmpeg", "-nostdin", "-y", "-v", "error",
        "-protocol_whitelist", "file,pipe,fd",
        "-format_whitelist", "mov,matroska,webm,avi,flv", "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
        "-vf", "scale=960:540:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        "-r", "24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-pix_fmt", "yuv420p", "-g", "48", "-threads", "4",
        "-c:a", "aac", "-b:a", "96k", "-ac", "2",
        "-movflags", "+faststart", str(destination),
    ]


async def prepare_preview(source, destination):
    source = Path(source).resolve(strict=True)
    destination = Path(destination)
    temporary = destination.with_name(f".preview-{uuid.uuid4()}.mp4")
    try:
        child = await asyncio.create_subprocess_exec(
            *preview_command(source, temporary), stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE)
        try:
            _, stderr = await child.communicate()
        except asyncio.CancelledError:
            child.kill()
            await child.wait()
            raise
        if child.returncode:
            raise RuntimeError("Preview failed: " + stderr.decode(errors="replace")[-600:])
        # Commit only a readable completed file. No trimming: timestamps match source.
        await probe(temporary)
        os.replace(temporary, destination)
        return {"source": str(destination)}
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    request = json.loads(sys.stdin.read())
    print(json.dumps(asyncio.run(prepare_preview(request["source"], request["destination"]))))
