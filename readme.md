# Live Meeting Notes

A Tauri 2 desktop app that transcribes live meetings locally with [WhisperX](https://github.com/m-bain/whisperX), then generates AI summaries, action items, and open questions after Stop. Windows and Apple Silicon macOS builds are available; macOS uses BlackHole audio routing.

The existing interface, session history, corrections, action checkboxes, sourced question research, TXT imports, and TXT/Markdown exports are retained. Tauri owns windows/dialogs; a bundled Node backend retains the tested meeting and AI logic. A persistent Python worker handles native capture and WhisperX recognition/alignment. Earlier GitHub release downloads are still Electron builds.

## Run from source

Install Node.js 22.12 or later, stable Rust, Python 3.10–3.13 (3.12 recommended), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Windows needs Microsoft C++ Build Tools and WebView2; macOS needs Xcode Command Line Tools. Linux needs GTK 3, WebKitGTK 4.1, DBus development libraries, and PulseAudio/PipeWire.

Windows PowerShell:

```powershell
npm ci
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r python/requirements.txt
npm start
```

macOS/Linux:

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r python/requirements.txt
npm start
```

The requirements install CPU-only PyTorch on Windows/Linux. WhisperX always uses CPU with int8 inference; no CUDA runtime is needed. Choose the model, batch size, and thread limit in Settings. If TorchCodec reports FFmpeg loading errors, follow [TorchCodec's FFmpeg installation instructions](https://github.com/pytorch/torchcodec#installing-torchcodec), including shared DLLs on Windows.

The worker uses the project's `.venv`, or an absolute **Python interpreter** path in Settings, or `MEETING_PYTHON`. That interpreter must have the requirements installed. First Start downloads speech/alignment/VAD weights and may take several minutes. Models require substantial disk space; recognition runs locally after caching.

## Record a meeting

1. Select a physical microphone and use **Test audio** to check MIC and SYS. Configure routing below first.
2. Save your AI agent/model choices. Gain preview and three-second silence calibration work during an audio test.
3. Click **Start meeting**. Capture must open before a session is created. The main window minimizes and the transcript panel appears at the current monitor's right edge.
4. Click **Stop**. Capture delivers its final frame, recognition drains, the transcript saves, the full window returns, and AI notes generate. **Expand** restores the full window while recording continues.
5. Correct text, check actions, research questions, reopen history, or export TXT/Markdown.

WhisperX processes batches. The app feeds chunks of up to six seconds with overlap; live updates appear after recognition finishes. Word alignment supports overlap trimming. The footer reports inference time, queue size, real-time factor, and latency. If the queue grows, choose a smaller model or adjust the CPU thread limit.

Captures all system sound. Teams mute does not mute this app; use **Mute mic** here. **Pause** silences both inputs while retaining elapsed time. Headphones reduce duplicate speaker audio entering the mic. Stop before changing devices. Diarization, live AI summaries, video import, and Teams-only capture are not implemented.

## Audio routing

**Windows:** SoundCard uses WASAPI loopback for the default output plus the selected microphone. Enable microphone access for desktop apps in Windows Privacy settings. A usable output device must be present.

**macOS:** Install [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole). In Audio MIDI Setup create a Multi-Output Device containing BlackHole and your headphones/speakers. Use the physical output as clock source, enable BlackHole drift correction, and select the Multi-Output Device as system output. Select a physical microphone in this app. The worker reads BlackHole separately. Allow microphone access for the app/Python process in System Settings → Privacy & Security; source launches can attribute access to Terminal. Without BlackHole, capture fails before creating a meeting. Native ScreenCaptureKit capture is not implemented.

**Linux:** Uses the default PulseAudio output monitor and microphone. PipeWire needs its PulseAudio compatibility server; ALSA-only capture is unsupported.

## AI API configuration

Open **Audio, AI API and transcript settings** and choose **Local proxy (OpenAI compatible)** or **Gemini API**. Configure the base URL, API key, summary model, and optional answer model. Use a proxy base such as http://127.0.0.1:4000/v1; the app calls /chat/completions. Gemini uses https://generativelanguage.googleapis.com/v1beta, a Gemini API key, and a supported model such as gemini-2.5-flash. A blank answer model uses the summary model. No AI CLI is called or required.

Saving writes AI_PROVIDER, AI_BASE_URL, AI_API_KEY, AI_SUMMARY_MODEL, and AI_ANSWER_MODEL to .env in the app's local data directory. The file loads on startup for reuse and can be edited directly while the app is closed. See .env.example for the format. The key is stored in that file as requested, with user-only file permissions on Unix, and is omitted from UI state, meeting documents, and error messages. Leave the key input blank to keep the saved key when the provider and URL are unchanged.

Use **Test AI API connection** before generating notes. Summary JSON is validated against the transcript: owners, dates, and evidence must come from cited passages. Gemini question research uses Google Search grounding and accepts only returned grounding URLs. Proxy-generated answers include their text but are marked unverified because generic chat-completion proxies do not provide independently verified search citations. API jobs can be cancelled and have a ten-minute timeout.

## Storage and privacy

Session JSON remains compatible with the previous app. Windows uses `%APPDATA%\Live Meeting Notes`; macOS uses `~/Library/Application Support/Live Meeting Notes`; Linux uses `~/.local/share/Live Meeting Notes`. The default automatic Markdown/TXT folder is `scripts` inside that directory; existing custom folders are retained. Models cache in `whisperx/models`. Old VAD and CPU/CUDA preferences migrate; WhisperX uses CPU/int8 only.

Each meeting automatically writes a complete Markdown file containing the transcript, summary, to-do list, questions, answers, sources, and completion flags. It updates after edits, checked tasks, and researched answers. TXT exports remain available for compatible imports. Unchanged automatic TXT files reopen their saved notes, actions, and answers. External edits import as new sessions; automatic saving preserves changed content in separate edited copies. Transcript corrections invalidate notes/answers. Regeneration asks before replacing reviewed data and publishes replacements only after successful persistence.

Audio is deleted only after successful transcript/session saving. Pending WAV/timing journals survive interruption for recovery. TXT save errors leave session JSON durable, and TXT is rebuilt on startup. Set `MEETING_DATA_DIR` to a temporary directory for isolated checks.

Speech is local. AI summaries send transcript context to the chosen provider; research sends the question and supporting passages to the provider/search service. The backend uses private stdio rather than an HTTP speech server.

## Build and verify

```bash
npm test
python3 -m unittest discover -s test -p 'test_*.py'
npm run build:web
npm run prepare:resources
cargo check --manifest-path src-tauri/Cargo.toml
npm run build
```

Build on the matching OS/architecture. Installer artifacts appear under `src-tauri/target/release/bundle`. `prepare:resources` bundles the host Node runtime, backend, and worker sources. Installers and Mac apps require a separate Python/WhisperX environment. The Windows portable executable includes the full CPU environment and default English models. Configure platform signing for trusted distribution.

The desktop workflow builds Windows/macOS and runs Node/Python checks. Hardware capture and live AI provider behavior needs native verification. Historical Electron benchmarks describe the previous engine only. For real speech checks, supply a short mono 16-kHz English WAV:

```bash
node scripts/native-smoke.cjs /absolute/path/short-english.wav
node scripts/benchmark.cjs --wav /absolute/path/short-english.wav --model base.en --runs 3
```

See [design](docs/tauri-whisperx.md) and [verification](docs/verification.md).

## Windows portable releases

Download the Windows x64 **portable.exe** from GitHub Releases and double-click it. There is no installer, administrator requirement, or separate Python/Node/WebView2 setup. The executable bundles CPU WhisperX, FFmpeg, WebView2, base.en, English alignment, and Silero VAD. First launch extracts approximately 5 GB of runtime files to %LOCALAPPDATA%\Live Meeting Notes\portable; subsequent launches reuse that cache. Settings and meeting files retain their existing app-data paths. Additional speech models download when selected.

To build on Windows after npm run build:

    ./scripts/test-portable-windows.ps1
    ./scripts/prepare-portable-windows.ps1 -AppDirectory src-tauri/target/release -OutputDirectory resources/portable
    ./scripts/build-portable-windows.ps1 -PayloadDirectory resources/portable -Output dist/releases/Live-Meeting-Notes-0.4.0-windows-x64-portable.exe
    ./scripts/verify-portable-windows.ps1 -Executable dist/releases/Live-Meeting-Notes-0.4.0-windows-x64-portable.exe

The builder omits .env and credential files from public executables. -IncludePrivateDefaults retains only the runtime .env for a private configured copy; never upload that copy. Version tags run the Windows workflow, verify offline CPU recognition, and publish the portable executable and checksum alongside Mac assets. Windows binaries remain unsigned. Bundled WebView2 is fixed at build time; updating it requires rebuilding the portable executable.

## macOS releases

Apple Silicon Macs (M1 or later) with macOS 12 or later are supported. Current WhisperX/PyTorch dependencies do not provide Intel Mac wheels, so Intel releases are not produced.

On an Apple Silicon Mac, run npm run dist:mac and then npm run release:mac. The release script validates the app and Node architectures, signatures, microphone usage declaration, and packaged backend startup, then creates a DMG, ZIP, and SHA256SUMS.txt under dist/releases.

Pushing a version tag such as v0.4.0 runs the Release macOS workflow. It also checks real CPU speech recognition on the Mac runner before publishing the DMG and ZIP to GitHub Releases. API keys are omitted from public releases; enter your API settings in the app for reuse in its app-data .env file.

The app uses ad-hoc signatures and is not notarized. Python/WhisperX and BlackHole remain separate installation prerequisites. See the Mac release notes for details.

## License

[MIT](LICENSE). Runtime/model notices: [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
