from copy import deepcopy
from types import SimpleNamespace

import pytest

from clip_engine.services.hook_selection import DIMENSIONS, select_hook


def scores(value):
    return dict.fromkeys(DIMENSIONS, value)


def sample():
    transcript = [
        SimpleNamespace(start_time_ms=10000, end_time_ms=14000, text="Przejdźmy teraz do podlewania.", speaker_label="S1"),
        SimpleNamespace(start_time_ms=15024, end_time_ms=19000, text="Najczęstszy błąd to podlewanie codziennie.", speaker_label="S1"),
    ]
    data = {"baseline_scores": scores(5), "alternatives": [
        {"start_time": 15.0, "quote": "Najczęstszy błąd to podlewanie", "scores": scores(9)},
    ]}
    return transcript, data


def test_real_transcript_time_is_used_and_original_range_is_saved():
    transcript, data = sample()
    original = deepcopy(data)
    start, audit = select_hook(data, transcript, 10000, 45000, 15000, 60000)
    assert start == 15024  # The model only sees the rounded 15.0 timestamp.
    assert audit["applied"]
    assert audit["original_start_time_ms"] == 10000
    assert audit["selected_end_time_ms"] == audit["original_end_time_ms"] == 45000
    assert audit["quote"] == data["alternatives"][0]["quote"]
    assert data == original


@pytest.mark.parametrize("problem", ["invented_quote", "unknown_time", "mid_sentence", "weak",
                                    "lost_context", "nan", "short", "outside_range", "missing"])
def test_unsafe_or_unhelpful_proposals_keep_the_original(problem):
    transcript, data = sample()
    candidate = data["alternatives"][0]
    end, lower = 45000, 0
    if problem == "invented_quote": candidate["quote"] = "Tego nikt ci nie powie"
    if problem == "unknown_time": candidate["start_time"] = 16
    if problem == "mid_sentence": transcript[0].text = "Przejdźmy teraz do"
    if problem == "weak": candidate["scores"] = scores(5.5)
    if problem == "lost_context": candidate["scores"]["clarity"] = 3
    if problem == "nan": candidate["scores"]["interest"] = float("nan")
    if problem == "short": end = 29000
    if problem == "outside_range": lower = 16000
    if problem == "missing": data = None
    start, audit = select_hook(data, transcript, 10000, end, 15000, 60000, lower)
    assert start == 10000
    assert not audit["applied"]
