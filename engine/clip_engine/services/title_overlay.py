"""Editable title layer. Preview and export share the exact same raster image."""
import asyncio
import base64
import io
import json
import math
import re
import shutil
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DEFAULTS = dict(enabled=True, mode="intro", start=0, end=3, size=42,
                color="#000000", background="#ffffff", opacity=0.95,
                position="auto", y=6, fade=True, style="card", font="montserrat", uppercase=False, radius=16)


def options(value=None):
    if value is not None and not isinstance(value, dict):
        raise ValueError("Invalid title settings")
    result = {**DEFAULTS, **(value or {})}
    for key in ("enabled", "fade", "uppercase"):
        if type(result[key]) is not bool:
            raise ValueError("Invalid title toggle")
    for key, allowed in dict(mode=("all", "intro", "range"), position=("auto", "manual"),
                             font=("montserrat", "poppins", "anton", "serif"), style=("card", "plain", "outline")).items():
        if result[key] not in allowed:
            raise ValueError("Invalid title style")
    for key, low, high in (("start", 0, 21600), ("end", 0.1, 21600),
                           ("size", 20, 100), ("opacity", 0, 1), ("y", 0, 90), ("radius", 0, 100)):
        v = result[key]
        if type(v) not in (int, float) or not math.isfinite(v) or not low <= v <= high:
            raise ValueError(f"Invalid title {key}")
    if result["mode"] == "range" and result["end"] <= result["start"]:
        raise ValueError("Title end must follow start")
    for key in ("color", "background"):
        if not isinstance(result[key], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", result[key]):
            raise ValueError("Invalid title colour")
    return {key: result[key] for key in DEFAULTS}


def title_text(value):
    if not isinstance(value, str) or len(value) > 240 or "\x00" in value:
        raise ValueError("Title must be at most 240 characters")
    return " ".join(value.split())


def timing(settings, duration):
    start = settings["start"] if settings["mode"] == "range" else 0
    end = duration if settings["mode"] == "all" else min(duration, settings["end"])
    return start, end, min(0.25, max(0, end - start) / 2) if settings["fade"] else 0


def draw_title(text, settings, width, height):
    text = title_text(text)
    scale = min(width / 1080, height / 1080 if width > height else width / 1080)
    if settings["uppercase"]:
        text = text.upper()
    fonts = {"montserrat": "Montserrat-Black.ttf", "poppins": "Poppins-Black.ttf", "anton": "Anton-Regular.ttf", "serif": "InstrumentSerif-Italic.ttf"}
    font_path = Path(__file__).resolve().parents[2] / "assets/fonts" / fonts[settings["font"]]
    font_size = max(8, round(settings["size"] * scale))
    padding = max(4, round(22 * scale))
    measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    max_width = max(20, int(width * .9) - padding * 2)
    while True:
        font = ImageFont.truetype(str(font_path), font_size)
        lines, line = [], ""
        # Character wrapping also handles a long single word without truncating it.
        for char in text:
            if line and measure.textlength(line + char, font=font) > max_width:
                split = line.rfind(" ")
                if split > 0:
                    lines.append(line[:split])
                    line = line[split + 1:] + char
                else:
                    lines.append(line)
                    line = char
            else:
                line += char
        if line.strip():
            lines.append(line.strip())
        line_h = round(font_size * 1.35)
        if len(lines) * line_h + padding * 2 <= height * .35 or font_size <= 8:
            break
        font_size -= 1
    image_width = min(width, math.ceil(max((measure.textlength(line, font=font) for line in lines), default=1)) + padding * 2)
    image_height = max(1, len(lines) * line_h + padding * 2)
    image = Image.new("RGBA", (image_width, image_height))
    draw = ImageDraw.Draw(image)
    if settings["style"] == "card":
        rgb = tuple(int(settings["background"][i:i + 2], 16) for i in (1, 3, 5))
        draw.rounded_rectangle((0, 0, image_width - 1, image_height - 1), radius=round(settings["radius"] * scale),
                               fill=(*rgb, round(settings["opacity"] * 255)))
    for i, line in enumerate(lines):
        stroke = max(1, round(3 * scale)) if settings["style"] == "outline" else 0
        draw.text((image_width / 2, padding + i * line_h), line, font=font, anchor="mt",
                  fill=settings["color"], stroke_width=stroke, stroke_fill=settings["background"])
    y_percent = (4 if width > height else 6) if settings["position"] == "auto" else settings["y"]
    y = min(max(0, round(height * y_percent / 100)), max(0, height - image_height))
    return image, y


async def probe(source):
    process = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv", "-show_streams", "-show_format", "-of", "json", str(source),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, _ = await process.communicate()
    if process.returncode:
        raise RuntimeError("Cannot read the title-free clip")
    data = json.loads(stdout)
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    return video["width"], video["height"], float(data["format"]["duration"])


async def export_title(source, destination, text, config):
    settings = options(config)
    text = title_text(text)
    width, height, duration = await probe(source)
    start, end, fade = timing(settings, duration)
    if settings["enabled"] and text and start >= duration:
        raise ValueError("Title starts after the end of this clip")
    if not settings["enabled"] or not text:
        shutil.copy2(source, destination)
        return
    image, y = draw_title(text, settings, width, height)
    with tempfile.TemporaryDirectory(prefix="bridgeclip-title-") as directory:
        png = Path(directory) / "title.png"
        image.save(png)
        image_filter = "format=rgba"
        if fade:
            image_filter += f",fade=t=in:st={start}:d={fade}:alpha=1,fade=t=out:st={end-fade}:d={fade}:alpha=1"
        graph = f"[1:v]{image_filter}[title];[0:v][title]overlay=x=(W-w)/2:y={y}:enable='between(t,{start},{end})':shortest=1[v]"
        bitrate = max(6, 18 * width * height / (1080 * 1920))
        codec = ["-c:v", "h264_videotoolbox", "-b:v", f"{bitrate:g}M"] if sys.platform == "darwin" else ["-c:v", "libx264", "-crf", "18", "-preset", "fast"]
        command = ["ffmpeg", "-y", "-v", "error", "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv", "-i", str(source),
                   "-loop", "1", "-i", str(png), "-filter_complex", graph, "-map", "[v]", "-map", "0:a?",
                   *codec, "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", str(destination)]
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            _, stderr = await process.communicate()
        except asyncio.CancelledError:
            process.kill()
            await process.wait()
            raise
        if process.returncode:
            raise RuntimeError("Title export failed: " + stderr.decode(errors="replace")[-600:])


async def main():
    request = json.loads(sys.stdin.read())
    settings = options(request.get("options"))
    text = title_text(request["text"])
    if request["action"] == "preview":
        width, height, duration = await probe(request["source"])
        image, y = draw_title(text, settings, width, height)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        print(json.dumps(dict(image="data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(),
                              width=width, height=height, imageWidth=image.width, imageHeight=image.height,
                              y=y, duration=duration)))
    elif request["action"] == "export":
        await export_title(request["source"], request["destination"], text, settings)
        print("{}")
    else:
        raise ValueError("Unknown title action")


if __name__ == "__main__":
    asyncio.run(main())
