"""Conservative hook selection from the existing planner response; no API calls."""
import math
import re


DIMENSIONS = ("interest", "clarity", "specificity", "continuity", "naturalness")
SCORES_SCHEMA = {
    "type": "object",
    "properties": {key: {"type": "number", "minimum": 0, "maximum": 10} for key in DIMENSIONS},
    "required": list(DIMENSIONS), "additionalProperties": False,
}
HOOK_SCHEMA = {
    "type": "object",
    "properties": {
        "baseline_scores": SCORES_SCHEMA,
        "alternatives": {
            "type": "array", "maxItems": 2,
            "items": {
                "type": "object",
                "properties": {
                    "start_time": {"type": "number"},
                    "quote": {"type": "string"},
                    "scores": SCORES_SCHEMA,
                },
                "required": ["start_time", "quote", "scores"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["baseline_scores", "alternatives"], "additionalProperties": False,
}

HOOK_PROMPT = """
## OPTIONAL STRONGER OPENING
First choose each complete clip normally: start_time/end_time remain its BASELINE range.
Additionally return a hook object per clip with baseline_scores and alternatives (0-2).
Compare nearby openings: at most 10 seconds BEFORE or 15 seconds AFTER the baseline start.
Use only starts of transcript lines that begin a complete new sentence or speaker turn.
Never reorder speech, invent words, remove necessary context, or change the ending.
Each alternative must keep the clip within the requested duration and source range.
For each alternative supply start_time in seconds, quote (copy the first 3-20 spoken
words of that transcript line verbatim), and scores. Empty alternatives are fine.
Score baseline and alternatives on the SAME calibrated 0-10 rubric:
interest: gives the viewer a reason to keep watching in the first few seconds;
clarity: understandable without earlier context (penalize unexplained references);
specificity: quickly reaches a concrete thought, question or problem;
continuity: the remaining clip develops and delivers on that opening;
naturalness: preserves the speaker's meaning and a natural complete beginning.
Do not reward clickbait keywords by themselves. Never truncate a sentence to get a hook.
Only offer alternatives that clearly improve the baseline, not minor stylistic changes.
The hook object is {"baseline_scores": {"interest": 0, "clarity": 0,
"specificity": 0, "continuity": 0, "naturalness": 0}, "alternatives":
[{"start_time": 0, "quote": "exact spoken words", "scores": {"interest": 0,
"clarity": 0, "specificity": 0, "continuity": 0, "naturalness": 0}}]}.
"""


def _scores(value):
    if not isinstance(value, dict):
        return None
    if any(isinstance(value.get(k), bool) or not isinstance(value.get(k), (int, float))
           or not math.isfinite(value[k]) or not 0 <= value[k] <= 10 for k in DIMENSIONS):
        return None
    return {k: value[k] for k in DIMENSIONS}


def _tokens(text):
    return re.findall(r"\w+", text.casefold())


def _rating(scores):
    return sum(scores.values()) / len(DIMENSIONS)


def select_hook(data, transcript, start_ms, end_ms, min_ms, max_ms, lower_ms=0, upper_ms=None):
    """Return a validated start and audit metadata; malformed/weak proposals keep baseline.

    Called AFTER normal sentence snapping so later snapping cannot undo the hook.
    Timestamps from prompt lines are rounded to tenths; map them back to exact source ms.
    """
    audit = {
        "version": 1, "applied": False,
        "original_start_time_ms": start_ms, "original_end_time_ms": end_ms,
        "selected_start_time_ms": start_ms, "selected_end_time_ms": end_ms,
        "quote": "", "alternatives": [],
    }
    if not isinstance(data, dict):
        return start_ms, audit
    baseline = _scores(data.get("baseline_scores"))
    alternatives = data.get("alternatives")
    if baseline is None or not isinstance(alternatives, list):
        return start_ms, audit
    audit["baseline_scores"] = baseline
    for candidate in alternatives[:2]:
        if not isinstance(candidate, dict):
            continue
        time = candidate.get("start_time")
        quote = candidate.get("quote")
        scores = _scores(candidate.get("scores"))
        if (isinstance(time, bool) or not isinstance(time, (int, float)) or not math.isfinite(time)
                or not isinstance(quote, str) or len(quote) > 500 or scores is None):
            continue
        # Match the exact displayed timestamp, then use unrounded transcript timing.
        matches = [(i, s) for i, s in enumerate(transcript)
                   if abs(float(f"{s.start_time_ms / 1000:.1f}") - time) < 0.001]
        if len(matches) != 1:
            continue
        index, segment = matches[0]
        proposed = segment.start_time_ms
        if (proposed == start_ms or not start_ms - 10000 <= proposed <= start_ms + 15000
                or proposed < lower_ms or not min_ms <= end_ms - proposed <= max_ms
                or (upper_ms is not None and end_ms > upper_ms)):
            continue
        if index:
            previous = transcript[index - 1]
            sentence_end = bool(re.search(r'[.!?…][\s”"\'»)]*$', previous.text))
            speaker_turn = (getattr(segment, "speaker_label", None) is not None
                            and getattr(previous, "speaker_label", None) is not None
                            and segment.speaker_label != previous.speaker_label)
            if not sentence_end and not speaker_turn:
                continue
        spoken, quoted = _tokens(segment.text), _tokens(quote)
        if len(quoted) < min(3, len(spoken)) or not quoted or spoken[:len(quoted)] != quoted:
            continue
        # A stronger opening must not trade away context or meaning for attention.
        if any(scores[k] < max(7, baseline[k]) for k in ("clarity", "continuity", "naturalness")):
            continue
        if scores["interest"] <= baseline["interest"] or _rating(scores) < _rating(baseline) + 1:
            continue
        audit["alternatives"].append({"start_time_ms": proposed, "quote": quote, "scores": scores})
    if audit["alternatives"]:
        best = max(audit["alternatives"], key=lambda c: (_rating(c["scores"]), -abs(c["start_time_ms"] - start_ms)))
        audit.update(applied=True, selected_start_time_ms=best["start_time_ms"], quote=best["quote"])
        return best["start_time_ms"], audit
    return start_ms, audit
