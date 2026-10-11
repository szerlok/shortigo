"""Local background music. Always mix from a dry clip; video is stream-copied."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import sys
import tempfile
import uuid

MUSIC_ROOT = Path(__file__).resolve().parents[3] / 'music'
LEVELS = {'subtle': .32, 'standard': .46, 'strong': .60}


def tracks():
    if not MUSIC_ROOT.is_dir():
        return []
    return [{'id': hashlib.sha256(p.name.encode()).hexdigest()[:16],
             'name': p.stem.replace('_', ' '), 'path': str(p)}
            for p in sorted(MUSIC_ROOT.iterdir())
            if p.is_file() and not p.is_symlink() and p.suffix.lower() in {'.wav', '.mp3', '.m4a', '.flac'}]


def validate(value):
    if not isinstance(value, dict) or type(value.get('enabled')) is not bool or value.get('level') not in LEVELS:
        raise ValueError('Invalid music settings')
    track_id = value.get('trackId')
    if value['enabled'] and not any(t['id'] == track_id for t in tracks()):
        raise ValueError('Music track unavailable')
    return {'enabled': value['enabled'], 'trackId': track_id, 'level': value['level']}


def choices(count):
    catalog = tracks()
    if not catalog:
        raise ValueError('No music tracks in music folder')
    result = []
    while len(result) < count:
        batch = catalog.copy()
        random.shuffle(batch)
        if result and len(batch) > 1 and batch[0]['id'] == result[-1]['trackId']:
            batch[0], batch[1] = batch[1], batch[0]
        result.extend({'enabled': True, 'trackId': t['id'], 'level': 'subtle'} for t in batch)
    return result[:count]


async def command(*args):
    proc = await asyncio.create_subprocess_exec(*map(str, args), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await proc.communicate()
    except BaseException:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        raise
    if proc.returncode:
        raise RuntimeError(err.decode(errors='replace')[-2000:])
    return out


async def normalized(track):
    path = Path(track['path'])
    stat = path.stat()
    key = hashlib.sha256(f'{path}:{stat.st_size}:{stat.st_mtime_ns}:v1'.encode()).hexdigest()
    cache = Path(tempfile.gettempdir()) / f'bridgeclip-music-{os.getuid() if hasattr(os, "getuid") else "local"}'
    cache.mkdir(mode=0o700, exist_ok=True)
    if cache.is_symlink() or (hasattr(os, 'getuid') and cache.stat().st_uid != os.getuid()):
        raise ValueError('Invalid music cache')
    dest = cache / f'{key}.wav'
    if dest.is_file() and not dest.is_symlink():
        return dest
    temporary = cache / f'{key}-{uuid.uuid4()}.wav'
    try:
        await command('ffmpeg', '-v', 'error', '-nostdin', '-i', path, '-vn', '-af',
                      'loudnorm=I=-18:TP=-2:LRA=9', '-ar', '48000', '-ac', '2', temporary)
        temporary.replace(dest)
    finally:
        temporary.unlink(missing_ok=True)
    return dest


async def mix(source, destination, settings, audio_only=False):
    config = validate(settings)
    if not config['enabled']:
        if audio_only:
            await command('ffmpeg', '-v', 'error', '-nostdin', '-i', source, '-vn', '-c:a', 'aac', '-b:a', '192k', destination)
        else:
            shutil.copy2(source, destination)
        return
    info = json.loads(await command('ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', source))
    if not any(s['codec_type'] == 'audio' for s in info['streams']):
        raise ValueError('Clip has no audio')
    duration = float(info['format']['duration'])
    track = next(t for t in tracks() if t['id'] == config['trackId'])
    music = await normalized(track)
    fade = min(1., duration / 2)
    # Keep the bed steady during speech, with only the opening ramp and ending fade.
    graph = (
        '[0:a:0]loudnorm=I=-16:TP=-2:LRA=11,aresample=48000[voice];'
        f"[1:a:0]atrim=duration={duration},asetpts=PTS-STARTPTS,"
        f"volume='{LEVELS[config['level']]}*if(lt(t,3),0.4,if(lt(t,6),0.4+0.6*(t-3)/3,1))':eval=frame,"
        f'afade=t=in:d=0.3,afade=t=out:st={duration-fade}:d={fade}[music];'
        '[voice][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.891:level=false:latency=true[out]'
    )
    args = ['ffmpeg', '-v', 'error', '-nostdin', '-i', source, '-stream_loop', '-1', '-i', music,
            '-filter_complex', graph]
    if not audio_only:
        args += ['-map', '0:v:0', '-c:v', 'copy']
    args += ['-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', str(duration), '-movflags', '+faststart', destination]
    await command(*args)


async def main():
    request = json.load(sys.stdin)
    if request['action'] == 'tracks':
        print(json.dumps([{k: t[k] for k in ('id', 'name')} for t in tracks()]))
    else:
        await mix(request['source'], request['destination'], request['settings'], request['action'] == 'preview')
        print('{}')


if __name__ == '__main__':
    asyncio.run(main())
