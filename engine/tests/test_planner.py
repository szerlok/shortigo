"""
Offline tests for the clip planner's request building, response parsing,
scoring, retry classification and clip finalization. No network calls.
"""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from clip_engine.config import Settings
from clip_engine.services.intelligence_planner import (
    CLIP_PLAN_SCHEMA,
    ClipPlanSegment,
    IntelligencePlannerService,
    IntelligencePlanningError,
)
from clip_engine.services.transcription_service import (
    TranscriptSegment,
    TranscriptWord,
    TranscriptionResult,
)


def make_planner(**overrides) -> IntelligencePlannerService:
    planner = IntelligencePlannerService()
    planner.settings = Settings(_env_file=None, openrouter_api_key="test", **overrides)
    return planner


def make_transcript(seconds: int = 300) -> TranscriptionResult:
    segments = []
    for start in range(0, seconds, 5):
        words = [
            TranscriptWord(word=f"word{start}", start_time_ms=start * 1000, end_time_ms=start * 1000 + 2000),
            TranscriptWord(word="end.", start_time_ms=start * 1000 + 2000, end_time_ms=start * 1000 + 4500),
        ]
        segments.append(TranscriptSegment(
            start_time_ms=start * 1000,
            end_time_ms=start * 1000 + 4500,
            text=f"word{start} end.",
            speaker_label="S1" if (start // 5) % 2 == 0 else "S2",
            words=words,
            audio_events=["(laughter)"] if start == 60 else [],
        ))
    return TranscriptionResult(segments=segments, full_text="", duration_seconds=seconds)


def completion(content, model="google/test-model", cost=0.0123, finish_reason="stop"):
    return {
        "model": model,
        "choices": [{"message": {"content": content}, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200, "cost": cost},
    }


def clip(start, end, scores=(8, 8, 8, 8, 8), summary="Great Title Here"):
    return {
        "start_time": start,
        "end_time": end,
        "summary": summary,
        "scores": dict(zip(("hook", "standalone", "arc", "quotability", "ending"), scores)),
        "tags": ["tag"],
    }


class TestRequestPayload:
    def test_reasoning_payload_uses_schema_fallbacks_and_no_temperature(self):
        planner = make_planner(
            planner_model="primary/model",
            planner_fallback_models="fallback/one, primary/model ,fallback/two",
            planner_reasoning_effort="high",
        )
        fallbacks = planner.settings.get_planner_fallback_models()
        payload = planner._build_request_payload("primary/model", fallbacks, [])

        assert fallbacks == ["fallback/one", "fallback/two"]
        assert payload["models"] == ["fallback/one", "fallback/two"]
        assert payload["reasoning"] == {"effort": "high", "exclude": True}
        assert "temperature" not in payload
        assert payload["response_format"]["json_schema"]["schema"] is CLIP_PLAN_SCHEMA
        assert payload["response_format"]["json_schema"]["strict"] is True
        assert payload["provider"] == {"require_parameters": True}

    def test_reasoning_none_sends_temperature_instead(self):
        planner = make_planner(planner_reasoning_effort="none")
        payload = planner._build_request_payload("m", [], [])
        assert "reasoning" not in payload
        assert payload["temperature"] == 0.2
        assert "models" not in payload

    def test_schema_is_strict_compatible(self):
        """Strict structured outputs require every property to be required."""
        def walk(node):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
                assert set(node["required"]) == set(node["properties"])
                for child in node["properties"].values():
                    walk(child)
            if node.get("type") == "array":
                walk(node["items"])
        walk(CLIP_PLAN_SCHEMA)


class TestTranscriptFormatting:
    def test_includes_speakers_and_audio_events(self):
        planner = make_planner()
        text = planner._build_transcript_text(make_transcript(70).segments)
        assert "[0.0 - 4.5] (S1) word0 end." in text
        assert "[60.0 - 64.5] (S1) word60 end. (laughter)" in text

    def test_text_only_messages_do_not_mention_frames(self):
        planner = make_planner()
        segs = make_transcript(30).segments
        messages = planner._build_vision_messages("sys", "transcript", [], 3, segs)
        user_text = " ".join(part["text"] for part in messages[1]["content"])
        assert "frame" not in user_text.lower()


class TestScoring:
    def test_scores_are_averaged(self):
        assert IntelligencePlannerService._score_clip(clip(0, 30, (10, 8, 6, 4, 2))) == 0.6

    def test_scores_are_clamped(self):
        assert IntelligencePlannerService._score_clip(clip(0, 30, (15, 15, 15, 15, 15))) == 1.0

    def test_legacy_virality_score_fallback(self):
        assert IntelligencePlannerService._score_clip({"virality_score": 0.7}) == 0.7
        assert IntelligencePlannerService._score_clip({}) == 0.5


class TestFinalizeClips:
    def test_drops_overlaps_keeps_best_and_caps(self):
        planner = make_planner()
        clips = [
            ClipPlanSegment(start_time_ms=0, end_time_ms=30000, virality_score=0.6),
            ClipPlanSegment(start_time_ms=10000, end_time_ms=40000, virality_score=0.9),  # overlaps both
            ClipPlanSegment(start_time_ms=60000, end_time_ms=90000, virality_score=0.7),
            ClipPlanSegment(start_time_ms=100000, end_time_ms=130000, virality_score=0.5),
        ]
        kept = planner._finalize_clips(clips, clip_count=2)
        assert [c.virality_score for c in kept] == [0.9, 0.7]

    def test_small_overlap_is_allowed(self):
        planner = make_planner()
        clips = [
            ClipPlanSegment(start_time_ms=0, end_time_ms=30000, virality_score=0.8),
            ClipPlanSegment(start_time_ms=26000, end_time_ms=56000, virality_score=0.7),
        ]
        assert len(planner._finalize_clips(clips, clip_count=5)) == 2


class TestParsing:
    def test_empty_content_is_retryable(self):
        planner = make_planner()
        planner._current_transcript = []
        with pytest.raises(IntelligencePlanningError) as exc:
            planner._parse_clip_plan_response(completion(None, finish_reason="length"))
        assert exc.value.retryable

    def test_malformed_json_is_retryable(self):
        planner = make_planner()
        planner._current_transcript = []
        with pytest.raises(IntelligencePlanningError) as exc:
            planner._parse_clip_plan_response(completion("not json at all"))
        assert exc.value.retryable


class FakeClient(httpx.AsyncClient):
    """Exercise the actual streaming client against queued offline responses."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.payloads = []

        class Body(httpx.AsyncByteStream):
            def __init__(self, body):
                self.body = body
            async def __aiter__(self):
                yield json.dumps(self.body).encode()

        async def handle(request):
            self.payloads.append(json.loads(request.content))
            item = self.responses.pop(0)
            if isinstance(item, Exception):
                raise item
            status, body = item
            return httpx.Response(status, stream=Body(body))

        super().__init__(base_url="https://example.invalid", transport=httpx.MockTransport(handle))


@pytest.fixture
def no_sleep(monkeypatch):
    async def instant(_):
        return None
    monkeypatch.setattr("clip_engine.services.intelligence_planner.asyncio.sleep", instant)


class TestPlanClips:
    @pytest.mark.parametrize("enabled", [False, True])
    def test_stronger_hook_is_opt_in_and_uses_one_existing_request(self, enabled):
        from clip_engine.services.hook_selection import DIMENSIONS
        planner = make_planner()
        data = clip(10, 40)
        data["hook"] = {
            "baseline_scores": dict.fromkeys(DIMENSIONS, 5),
            "alternatives": [{"start_time": 15, "quote": "word15 end.",
                              "scores": dict.fromkeys(DIMENSIONS, 9)}],
        }
        planner._http_client = FakeClient([(200, completion(json.dumps({"clips": [data]})))])
        result = asyncio.run(planner.plan_clips(
            transcript_result=make_transcript(60),
            video_metadata=SimpleNamespace(duration_seconds=60),
            max_clips=1, auto_clip_count=False,
            min_duration_seconds=15, max_duration_seconds=60, stronger_hook=enabled,
        ))
        assert len(planner._http_client.payloads) == 1
        payload = planner._http_client.payloads[0]
        assert ("OPTIONAL STRONGER OPENING" in payload["messages"][0]["content"]) == enabled
        properties = payload["response_format"]["json_schema"]["schema"]["properties"]["clips"]["items"]["properties"]
        assert ("hook" in properties) == enabled
        segment = result.segments[0]
        assert segment.start_time_ms == (15000 if enabled else 10000)
        assert bool(segment.hook_selection and segment.hook_selection["applied"]) == enabled

    @pytest.mark.parametrize("language", ["pl", None, "en"])
    @pytest.mark.parametrize("longform", [False, True])
    def test_polish_language_rules_reach_request_and_titles_survive(self, language, longform):
        planner = make_planner()
        transcript = make_transcript(600 if longform else 300)
        transcript.language = language
        for segment in transcript.segments:
            segment.text = "Dlaczego warto mówić po polsku i zachować własny język."
        title = "Dlaczego warto mówić po polsku"
        end = 310 if longform else 40
        content = json.dumps({"insights": "Rozmowa po polsku", "clips": [clip(10, end, summary=title)]})
        planner._http_client = FakeClient([(200, completion(content))])

        result = asyncio.run(planner.plan_clips(
            transcript_result=transcript,
            video_metadata=SimpleNamespace(duration_seconds=transcript.duration_seconds),
            max_clips=1,
            auto_clip_count=False,
            min_duration_seconds=300 if longform else 15,
            max_duration_seconds=600 if longform else 60,
            aspect_ratio="16:9" if longform else "9:16",
        ))

        prompt = planner._http_client.payloads[0]["messages"][0]["content"]
        assert "Polish speech MUST produce natural" in prompt
        assert "trust the transcript" in prompt
        assert "they do not set the output language" in prompt
        assert json.dumps(language or "unknown") in prompt
        assert result.segments[0].summary == title

    def _plan(self, planner, responses):
        planner._http_client = FakeClient(responses)
        return asyncio.run(planner.plan_clips(
            transcript_result=make_transcript(300),
            video_metadata=SimpleNamespace(duration_seconds=300),
            max_clips=3,
            auto_clip_count=False,
            min_duration_seconds=15,
            max_duration_seconds=60,
        ))

    def test_happy_path_records_real_cost_and_serving_model(self, no_sleep):
        planner = make_planner(planner_model="primary/model")
        content = json.dumps({
            "insights": "Podcast",
            "clips": [clip(10, 40, (6, 6, 6, 6, 6)), clip(100, 130, (9, 9, 9, 9, 9)), clip(200, 230)],
        })
        result = self._plan(planner, [(200, completion(content, model="fallback/served"))])

        assert [round(c.virality_score, 2) for c in result.segments] == [0.9, 0.8, 0.6]
        assert result.api_costs.model == "fallback/served"
        assert result.api_costs.estimated_cost_usd == 0.0123
        assert result.api_costs.attempts == 1

    def test_retries_rate_limit_then_succeeds(self, no_sleep):
        planner = make_planner()
        content = json.dumps({"insights": "x", "clips": [clip(10, 40)]})
        result = self._plan(planner, [
            (429, {"error": {"message": "rate limited"}}),
            httpx.ReadTimeout("slow"),
            (200, completion(content)),
        ])
        assert result.api_costs.attempts == 3
        assert len(result.segments) == 1

    def test_non_retryable_error_fails_fast(self, no_sleep):
        planner = make_planner()
        with pytest.raises(IntelligencePlanningError) as exc:
            self._plan(planner, [(401, {"error": {"message": "bad key"}})])
        assert not exc.value.retryable
        assert len(planner._http_client.payloads) == 1

    def test_retries_malformed_output_and_sums_cost(self, no_sleep):
        planner = make_planner()
        good = json.dumps({"insights": "x", "clips": [clip(10, 40)]})
        result = self._plan(planner, [
            (200, completion("{{not json", cost=0.01)),
            (200, completion(good, cost=0.02)),
        ])
        assert result.api_costs.attempts == 2
        assert result.api_costs.estimated_cost_usd == 0.03
