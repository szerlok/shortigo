"""Small local audio checks; no API requests."""
import asyncio
import subprocess
import numpy as np
from clip_engine.services import music


def test_music_envelope_steady_level_during_speech_and_video_copy(tmp_path, monkeypatch):
    monkeypatch.setattr(music, 'MUSIC_ROOT', tmp_path / 'tracks')
    music.MUSIC_ROOT.mkdir()
    def ffmpeg(*args):
        return subprocess.check_output(['ffmpeg', '-v', 'error', '-nostdin', *map(str, args)])
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=1000:duration=14', music.MUSIC_ROOT / 'bed.wav')
    for n in range(3):
        (music.MUSIC_ROOT / f'bed{n}.wav').write_bytes((music.MUSIC_ROOT / 'bed.wav').read_bytes())
    selected = music.choices(12)
    assert all(len({c['trackId'] for c in selected[i:i+4]}) == 4 for i in (0, 4, 8))
    assert all(a['trackId'] != b['trackId'] for a, b in zip(selected, selected[1:]))
    source = tmp_path / 'dry.mp4'
    ffmpeg('-f', 'lavfi', '-i', 'color=c=blue:s=160x284:r=10:d=14',
           '-f', 'lavfi', '-i', "sine=frequency=400:duration=14,volume='if(between(t,9,12),1,0)':eval=frame",
           '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source)
    output = tmp_path / 'mix.mp4'
    asyncio.run(music.mix(source, output, selected[0]))
    assert ffmpeg('-i', source, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-') == ffmpeg('-i', output, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-')
    samples = np.frombuffer(ffmpeg('-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'), dtype=np.float32)
    assert abs(len(samples)/48000 - 14) < .1
    assert max(abs(samples)) < .99
    def music_energy(start):
        part = samples[int(start*48000):int((start+.5)*48000)]
        fft = abs(np.fft.rfft(part * np.hanning(len(part))))
        return np.max(fft[495:506])  # 1000 Hz with 2 Hz bins, outside the voice tone.
    assert music_energy(7) > music_energy(1) * 1.8
    assert .9 < music_energy(10) / music_energy(7) < 1.1
    assert music_energy(13.4) < music_energy(7) * .7
    restored = tmp_path / 'restored.mp4'
    asyncio.run(music.mix(source, restored, {'enabled': False, 'trackId': None, 'level': 'subtle'}))
    assert restored.read_bytes() == source.read_bytes()
