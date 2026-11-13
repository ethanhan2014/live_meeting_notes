# Whisper and streaming Zipformer comparison

Keep Whisper as the meeting app's default for now. The tested Zipformer configuration provides faster provisional text, but its technical vocabulary results do not justify replacing the current recognizer. This is a comparison of one English model and two decoding configurations, not a verdict on all sherpa-onnx models.

Both Whisper and Zipformer are ASR models. whisper.cpp and sherpa-onnx are runtimes that execute them. Changing the runtime does not fix the separate AI-summary evidence checks.

The trials ran locally on Windows x64, Intel Core Ultra 5 135U, with 14 logical CPUs, Node v25.3.0, six recognition threads, and CPU inference. Whisper used the app's `base.en` model and whisper.cpp b5454, with VAD disabled. The standalone prototype used `sherpa-onnx-node@2.0.1` and the int8 English streaming Zipformer dated 2023-06-26, pinned to Hugging Face commit `672fbf1b30579d6585301139bb363f42a0ad4a24`. Model download hashes and configurations are recorded in [the raw public/synthetic results](asr-comparison-2026-11-06.json).

Whisper ran through the existing `SpeechEngine` and transcript guards, using six-second windows with 0.5 seconds of overlap. Zipformer accepted continuous 100-ms frames, then 400 ms of trailing padding and `inputFinished()`. Each fixture was recognized three times, sequentially. Timing includes recognition and its immediate wrapper; Whisper WAV preparation is outside its inference timer. CPU includes recognizer and Node wrapper work and excludes model startup. These are file-replay trials, not live microphone or system-audio capture tests.

The public/synthetic corpus contains 100.21 seconds of audio: eight newly generated SAP sentences using Microsoft David and Zira, three public human-speech samples, two altered public-speech samples, and three silence/noise/tone samples. [Fixture references](asr-comparison-fixtures.json) contain the expected text and explicitly accepted term variants. The altered speech samples have no established reference and are excluded from WER.

| Public/synthetic measurement | Whisper base.en | Zipformer greedy | Zipformer with hotwords |
| --- | ---: | ---: | ---: |
| SAP word error rate, term variants normalized | 4.5% (4/88) | 15.9% (14/88) | 17.0% (15/88) |
| SAP lexical word error rate | 6.8% | 15.9% | 17.0% |
| Listed SAP/name/percentage matches | 11/14 | 8/14 | 8/14 |
| Public human-speech word error rate | 11.4% (10/88) | 4.5% (4/88) | 3.4% (3/88) |
| Duration-weighted real-time factor | 0.348 | 0.140 | 0.267 |
| CPU seconds per second of replayed audio | 2.04 | 1.46 | 2.82 |
| Model startup, one measured launch | 1.33 s | 5.88 s | 6.56 s |
| Words emitted across silence/noise/tone fixtures, per repetition | 0 | 0 | 3 |

Real-time factor is processing seconds divided by audio seconds; lower is faster. CPU seconds sum work across threads and can exceed wall time. Public/synthetic outputs were identical across all three repetitions, so WER uses one output per fixture, and timing uses all three. Lexical scoring ignores case and punctuation and normalizes `%` and `per cent`. Term-normalized scoring additionally equates only the listed aliases, such as `eight percent` and `8%`; neither recognizer misread the percentage value. Scores were recalculated from saved text without repeating inference.

Whisper recognized FSCM in both synthesized voices. Both Zipformer configurations missed it, and all three configurations missed ACDOCA in these sentences. Whisper matched Rahul in one voice. The greedy configuration matched neither occurrence. The hotword trial used modified beam search, four active paths, score 1.5, BPE vocabulary exported with its original scores, and `SAP`, `ACDOCA`, `FSCM`, `RAHUL`, `SETTLEMENT`. It did not improve the term count. It emitted `I AM` on silence and `O` on harmonic tones in every repetition. Stress fixtures bypassed the app's capture silence gate, so these emissions are not a measurement of the production app's gated silence behavior.

On a paced replay of the public JFK sample plus two seconds of silence, Whisper first saved text at 7.14 seconds. The Zipformer hotword prototype first produced provisional text at 1.13 seconds and reached its first endpoint at 5.95 seconds. Saved text, a revisable partial, and an endpoint have different semantics; the measurements do not establish a direct final-transcript latency ratio. Zipformer also produced a few token timestamps 40 ms past the source duration because of tail padding. Any future integration needs timestamp bounds, partial replacement, endpoint handling, and existing transcript safeguards.

Two of the public human-speech fixtures are bundled with the Zipformer model and may favor that model. This is a small corpus: synthetic US voices and public read speech cannot establish performance on customer accents, overlapping speakers, or SAP discussions.

The customer recording was decoded locally using eight predetermined 30-second excerpts at 02:00, 07:00, 12:00, 17:00, 22:00, 27:00, 32:00, and 37:00. It is 41 minutes 28.83 seconds long; the trial covers four minutes, not the complete meeting. Customer audio, transcripts, source paths, and side-by-side output are saved only in local ignored build output. No human-verified transcript is available, so customer WER and term correctness remain unscored.

| Customer excerpt measurement | Whisper base.en | Zipformer greedy | Zipformer with hotwords |
| --- | ---: | ---: | ---: |
| Duration-weighted real-time factor | 0.394 | 0.119 | 0.199 |
| CPU seconds per second of replayed audio | 2.33 | 1.22 | 2.13 |
| False words in verified 30-second digital silence, per repetition | 0 | 0 | 2 |

Greedy Zipformer processed the sampled meeting audio 3.3 times faster than Whisper; the hotword configuration was about twice as fast. Some excerpts contain pauses, so these averages include non-speech processing. All three recognitions of each customer fixture produced the same text. The 22:00-22:30 excerpt contains exactly 480000 zero-valued PCM samples. Both Whisper and greedy Zipformer returned empty text; the meeting-specific hotword configuration emitted `I HAVE` in every repetition. This conclusion is based on the decoded audio, not on treating another recognizer's transcript as ground truth. Customer speech accuracy remains unscored.

Meeting hotwords were `SAP`, `BTP`, `PRINCIPAL PROPAGATION`, `CLOUD CONNECTOR`, `SAML`, `OAUTH`, `IAS`, and `SCC`, with the same beam-search settings as the synthetic trial. The original synthetic hotword file was restored afterwards.

The production backend and dependencies have not been changed by this trial. Keep the existing duplicate/letter-loop safeguards and AI evidence validation. A migration decision should follow listening review of the customer excerpts; greedy streaming is the promising latency candidate, while the tested hotword configuration adds CPU cost and non-speech emissions.

The reusable runner is [compare-asr.cjs](../../scripts/compare-asr.cjs). It requires Windows, prepared model files under `model/`, the isolated `sherpa-onnx-node` install under `node_modules/`, `model-source.json`, `hotwords.txt`, and a fixture manifest. A manifest contains `name`, `file`, `kind`, optional `reference`, optional `noSpeech`, and optional `terms` with `label` and `variants`. Missing references remain unscored. Each output destination must be new.

```powershell
node scripts/compare-asr.cjs --self-check
node --expose-gc scripts/compare-asr.cjs <workspace>
node --expose-gc scripts/compare-asr.cjs <workspace> customer-meeting/fixtures.json customer-meeting/results.json
```

Official references: [streaming JavaScript API](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_streaming_asr.html), [hotwords](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html), and [pinned model](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/tree/672fbf1b30579d6585301139bb363f42a0ad4a24).

Validation: benchmark scorer/chunk self-check passed; all 104 Linux app tests passed. Windows recognizer trials completed against the existing app resources. No sherpa Electron package, macOS trial, complete-meeting transcription, or live capture test was performed.
