"""Focused opt-in checks; no media rendering or provider requests."""
from clip_engine.services.clip_editor import (
    TimeMap, WindowWord, is_hesitation, remap_segments, remove_hesitation_intervals,
)
from clip_engine.services.rendering_service import RenderRequest, RenderingService
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord


def sample():
    words = [TranscriptWord(word=text, start_time_ms=start, end_time_ms=end)
             for text, start, end in [('To', 100, 650), ('yyy,', 1000, 1500), ('działa.', 1900, 2700)]]
    return TranscriptSegment(start_time_ms=100, end_time_ms=2700, text='To yyy, działa.', words=words)


def test_only_standalone_hesitations_match():
    assert all(is_hesitation(word) for word in ['yy', 'YYY…', 'eee,', 'eeee', 'ym', 'ymm', 'um'])
    assert not any(is_hesitation(word) for word in ['e', 'y', 'że', 'nie', 'no', 'tak', 'wiesz', 'hmm', 'mhm', 'eee-mail', 'yyyą'])


def test_opt_in_works_at_natural_pacing_and_shifts_captions():
    request = RenderRequest(video_path='unused.mp4', output_path='unused-out.mp4',
                            start_time_ms=0, end_time_ms=3000, source_width=1080, source_height=1920,
                            transcript_segments=[sample()], pacing='natural')
    before = RenderingService._keep_intervals(request, None, 0, 3000)
    assert before == [(0, 3000)]
    request.remove_hesitations = True
    keeps = RenderingService._keep_intervals(request, None, 0, 3000)
    time_map = TimeMap(keeps, 3000)
    assert 500 <= time_map.removed_ms <= 600
    assert not time_map.pieces_within(1000, 1500)
    captions = remap_segments([sample()], 0, time_map)
    assert [word.word for word in captions[0].words] == ['To', 'działa.']
    assert captions[0].words[-1].start_time_ms == 1900 - time_map.removed_ms
    request.remove_hesitations = False
    assert RenderingService._keep_intervals(request, None, 0, 3000) == before


def test_unsafe_cuts_and_reactions_are_preserved():
    keeps = [(0, 3000)]
    words = [WindowWord(100, 990, 'To'), WindowWord(1000, 1500, 'yyy'), WindowWord(1900, 2700, 'działa')]
    assert remove_hesitation_intervals(keeps, words) == keeps  # too close to real speech
    words[0].end_ms = 650
    assert remove_hesitation_intervals(keeps, words, [(900, 1600)]) == keeps
    assert remove_hesitation_intervals(keeps, [WindowWord(500, 900, 'yyy')]) == keeps


def test_edge_hesitations_and_neighboring_sounds_are_removed_without_slivers():
    words = [WindowWord(0, 500, 'yyy'), WindowWord(800, 1700, 'Działa'), WindowWord(2000, 2400, 'eee'), WindowWord(2420, 2900, 'yyy')]
    keeps = remove_hesitation_intervals([(0, 3000)], words)
    assert keeps[0][0] > 500
    assert keeps[-1][1] < 2000
    assert all(b - a >= 400 for a, b in keeps)


def test_caption_cleanup_hides_unsafe_audio_cuts_without_changing_timing():
    segment = TranscriptSegment(0, 1600, 'To yy działa.', words=[
        TranscriptWord('To', 0, 690), TranscriptWord('yy', 700, 770),
        TranscriptWord('działa.', 780, 1600),
    ])
    time_map = TimeMap([(0, 1600)], 1600)
    original = remap_segments([segment], 0, time_map)
    clean = remap_segments([segment], 0, time_map, omit_hesitations=True)
    assert original[0].text == 'To yy działa.'
    assert clean[0].text == 'To działa.'
    assert [(w.start_time_ms, w.end_time_ms) for w in clean[0].words] == [(0, 690), (780, 1600)]
    assert segment.text == 'To yy działa.'  # Stored transcript remains reusable.


def test_caption_cleanup_without_word_timings_and_only_hesitations():
    segments = [TranscriptSegment(0, 1000, 'Yyy, że eee... to działa.'),
                TranscriptSegment(1000, 2000, 'yy EEE…'),
                TranscriptSegment(2000, 3000, 'mhm e-mail y e nie')]
    time_map = TimeMap([(0, 3000)], 3000)
    clean = remap_segments(segments, 0, time_map, omit_hesitations=True)
    assert [s.text for s in clean] == ['że to działa.', 'mhm e-mail y e nie']
    assert (clean[0].start_time_ms, clean[0].end_time_ms) == (0, 1000)
    assert len(remap_segments(segments, 0, time_map)) == 3
