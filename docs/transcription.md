# Transcription

BridgeClip uses `microsoft/mai-transcribe-2` through OpenRouter for both clipping and automation metadata. The user's OpenRouter key also powers clip planning and metadata writing. There is no separate transcription key. Existing settings migrate without decrypting the retired ElevenLabs key; successful migration removes it while preserving the active provider keys and preferences.

The engine posts base64 audio JSON to `https://openrouter.ai/api/v1/audio/transcriptions`. It requests `verbose_json`, segment and word timestamps, and Azure speaker diarization. Custom vocabulary is passed through `provider.options.azure.phraseList.phrases`. See the [OpenRouter speech-to-text contract](https://openrouter.ai/docs/guides/overview/multimodal/stt) and [MAI Transcribe 2 model](https://openrouter.ai/microsoft/mai-transcribe-2).

Audio stays at its original speed. Long recordings use five-minute chunks with one second of overlap; word midpoints assign overlap words to one chunk, and timestamps are shifted to the original video timeline. Speaker labels are scoped to each chunk because separate requests cannot establish a person's identity across chunks. Speech without word timing fails instead of creating fabricated captions; a valid empty transcript can use visual-only planning. MAI does not supply the old provider's audio-event tags, so those remain empty.

Requests reject redirects, have a 90-second network timeout, and bound both audio and response sizes. The engine uses returned `usage.cost` when available, including zero; otherwise it estimates at $0.10 per input audio hour, the documented price on 2026-09-24. Overlap audio counts toward provider usage. Automation transcription requests text only and bounds the combined transcript before metadata generation.

`bridge/test_openrouter_transcription.py` covers the request, word timing, speaker 0, chunk offsets, cost reporting, silence, malformed results and safe provider failures. Automation tests exercise the OpenRouter payload with local mock services. Live provider behavior still needs a controlled run with an OpenRouter account; automated tests do not spend provider credits.
