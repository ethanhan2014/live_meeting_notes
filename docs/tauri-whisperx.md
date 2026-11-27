# Tauri / WhisperX rebuild

The core requirement is live microphone and system-audio transcription, followed by AI notes when the meeting stops. Preserve the existing summary/action/question tabs, direct local-proxy/Gemini API adapters, corrections, history, TXT imports, exports, and durable audio recovery.

Tauri 2 hosts the existing plain JavaScript interface. Rust owns windows, native dialogs, and a private stdio connection to a bundled Node runtime. The existing Node meeting/session/AI modules remain the backend; no HTTP server or credentials are exposed to the webview. A persistent Python worker uses WhisperX with Silero VAD and forced word alignment. Models load once, and the existing six-second chunk queue supplies live updates. Stop joins capture, delivers its last frame, drains recognition, saves, and only then generates notes.

Windows capture uses SoundCard WASAPI loopback plus a microphone. Linux uses PulseAudio/PipeWire's PulseAudio compatibility server. macOS requires BlackHole and a Multi-Output Device; SoundCard does not provide native macOS system loopback. Capture checks devices before creating a session. Muting and pausing apply before PCM leaves the worker.

Keep the existing session schema and Windows/macOS data directories. Add Python interpreter, model, and batch size settings; migrate the old optional VAD flag because WhisperX always uses VAD. WhisperX uses CPU/int8 exclusively. Python and its ML environment remain prerequisites for packaged builds; Node is bundled. First model use downloads weights. No diarization or live AI summaries are added.

Validation: existing Node suite, stdio subprocess integration, Python worker tests, renderer lifecycle tests, frontend build, Rust checks, and native speech smoke. Hardware capture, macOS routing, authenticated live AI API calls, and signed installers need native verification.

Implementation order: WhisperX worker and tests; capture and backend stdio lifecycle; Tauri bridge/windows/dialogs and renderer; packaging, setup documentation, verification.

AI configuration is reused from an app-data .env file; API keys are omitted from webview state. Complete meeting Markdown files are automatically saved alongside TXT compatibility exports.
