"""Render a small, non-destructive clip timeline with FFmpeg. No AI calls."""
import asyncio
import json
from pathlib import Path
import sys


async def command(*args):
    process = await asyncio.create_subprocess_exec(*map(str, args), stdout=asyncio.subprocess.PIPE,
                                                   stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await process.communicate()
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode:
        raise RuntimeError(err.decode(errors='replace')[-1600:])
    return out


async def probe(source):
    data = json.loads(await command('ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', source))
    video = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), None)
    if not video:
        raise ValueError('No video stream')
    return {'duration_ms': round(float(data['format']['duration']) * 1000),
            'width': int(video['width']), 'height': int(video['height']),
            'audio': any(s.get('codec_type') == 'audio' for s in data.get('streams', []))}


async def render(request):
    directory = Path(request['directory']).resolve(strict=True)
    destination = Path(request['destination'])
    if destination.parent.resolve(strict=True) != directory:
        raise ValueError('Destination outside run')
    project = request['project']
    segments = project['segments']
    overlays = project['overlays']
    first = await probe(directory / segments[0]['file'])
    width, height = first['width'], first['height']
    if request['preview']:
        limit = 640 if height >= width else 960
        factor = min(1, limit / max(width, height))
        width, height = round(width * factor), round(height * factor)
    width -= width % 2
    height -= height % 2
    if width < 2 or height < 2:
        raise ValueError('Invalid dimensions')
    args = ['ffmpeg', '-nostdin', '-y', '-v', 'error']
    graph = []
    labels = []
    input_index = 0
    total = 0.0
    for number, segment in enumerate(segments):
        source = directory / segment['file']
        info = await probe(source)
        start = segment['startMs'] / 1000
        duration = (segment['endMs'] - segment['startMs']) / 1000
        if segment['endMs'] > info['duration_ms'] + 150:
            raise ValueError('Segment exceeds source duration')
        args += ['-ss', str(start), '-t', str(duration), '-i', str(source)]
        video_index = input_index
        input_index += 1
        if info['audio']:
            audio_index = video_index
        else:
            args += ['-f', 'lavfi', '-t', str(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
            audio_index = input_index
            input_index += 1
        graph.append(f'[{video_index}:v:0]trim=duration={duration},setpts=PTS-STARTPTS,'
                     f'fps=30,scale={width}:{height}:force_original_aspect_ratio=decrease,'
                     f'pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{number}]')
        graph.append(f'[{audio_index}:a:0]atrim=duration={duration},asetpts=PTS-STARTPTS,'
                     f'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{number}]')
        labels.append(f'[v{number}][a{number}]')
        total += duration
    graph.append(''.join(labels) + f'concat=n={len(segments)}:v=1:a=1[joined][sound]')
    current = 'joined'
    for number, overlay in enumerate(overlays):
        source = directory / overlay['file']
        args += ['-loop', '1', '-framerate', '30', '-i', str(source)]
        image_index = input_index
        input_index += 1
        image_width = max(2, round(width * overlay['width']))
        graph.append(f'[{image_index}:v]scale={image_width}:-1,format=rgba[image{number}]')
        left = round(width * overlay['x'])
        top = round(height * overlay['y'])
        begin = overlay['startMs'] / 1000
        end = overlay['endMs'] / 1000
        output = f'layer{number}'
        graph.append(f"[{current}][image{number}]overlay=x={left}:y={top}:enable='between(t,{begin},{end})':eof_action=pass[{output}]")
        current = output
    args += ['-filter_complex', ';'.join(graph), '-map', f'[{current}]', '-map', '[sound]',
             '-t', str(total), '-c:v', 'libx264', '-preset', 'veryfast' if request['preview'] else 'medium',
             '-crf', '27' if request['preview'] else '19', '-pix_fmt', 'yuv420p', '-r', '30',
             '-c:a', 'aac', '-b:a', '128k' if request['preview'] else '192k', '-ar', '48000',
             '-movflags', '+faststart', str(destination)]
    await command(*args)
    result = await probe(destination)
    if result['duration_ms'] < 100:
        raise ValueError('Rendered clip is empty')
    return {'duration_ms': result['duration_ms'], 'width': width, 'height': height}


async def main():
    request = json.load(sys.stdin)
    if request['action'] == 'probe':
        print(json.dumps(await probe(request['source'])))
    elif request['action'] == 'render':
        print(json.dumps(await render(request)))
    else:
        raise ValueError('Unknown action')


if __name__ == '__main__':
    asyncio.run(main())
