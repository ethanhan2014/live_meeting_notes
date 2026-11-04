# Live Meeting Notes

[Download the Windows portable app](https://github.com/ethanhan2014/live_meeting_notes/releases/latest). Place the EXE in a writable folder and run it; the runtime and English speech resources are bundled. AI notes require an installed, authenticated AI CLI.

A Windows Electron app that transcribes meeting audio locally and turns the transcript into notes using an installed AI CLI.

- Live English transcription of system audio and microphone input with whisper.cpp.
- Separate **Summary**, **Action items**, and **Open questions** tabs, with key findings and key points.
- Persistent action checkboxes and researched answers with validated source links.
- Detection of **Codex**, **Claude Code**, **OpenCode**, and **Gemini CLI**, with separate agent/model/effort choices for summaries and answers.
- A narrow recording panel at the current screen's right edge, with **70% opacity**, live text, and Stop.
- Local session history, TXT transcript loading, automatic TXT saving, and complete TXT/Markdown exports.

## Requirements

Windows 10/11 x64 and desktop microphone access. Running from source also requires Node.js 22 or later and npm. Install and authenticate at least one supported AI CLI; its provider must support the selected model. Internet access is needed for setup downloads and online AI/search services. Speech recognition runs locally after setup.

## Quick start

Run in PowerShell:

```powershell
git clone https://github.com/ethanhan2014/live_meeting_notes.git
cd live_meeting_notes
npm ci
npm run prepare:resources
npm start
```

After setup, you can also double-click `Start Live Meeting Notes.cmd`.

`prepare:resources` downloads the pinned whisper.cpp Windows build, English `base.en` speech model, and optional Silero voice activity model. SHA256 checksums are verified before use. Resources and dependencies are excluded from Git.

## Record a meeting

1. Select a microphone and click **Test audio**. Check both MIC and PC meters.
2. Open **Audio, AI agents and transcript settings**. Choose agents, models and effort, then save.
3. Click **Start meeting**. The main app minimizes and the live transcript panel appears at the right edge of its screen.
4. Click **Stop** in the panel. The app flushes pending audio, saves the transcript, restores the full window, and generates notes. **Expand** opens the full app while recording continues.
5. Check completed action items, research individual questions, or export the complete document as TXT or Markdown.

Capture includes all PC sound. Teams mute does not mute this app's microphone; use **Mute mic** here. **Pause** silences both inputs while retaining elapsed meeting time. Headphones help reduce duplicate speaker audio entering the microphone.

Transcription arrives as short audio chunks finish recognition. The footer reports inference time, queue size, real-time factor and latency. Audio gain, CPU threads, silence threshold and optional VAD are configurable. Silence calibration measures quiet input for three seconds; repeat it after changing devices.

## AI agents and models

Follow the official installation and authentication instructions for [Codex](https://github.com/openai/codex), [Claude Code](https://code.claude.com/docs/en/setup), [OpenCode](https://opencode.ai/docs/), or [Gemini CLI](https://github.com/google-gemini/gemini-cli). **Rescan agents & files** refreshes native executable and npm installation detection. Detection does not verify account access to a model.

| Agent | Model setting | Effort setting |
| --- | --- | --- |
| Codex | A model supported by its configured provider | Minimal, low, medium, high, xhigh |
| Claude Code | `sonnet`, `opus`, `haiku`, or a supported model ID | Low, medium, high, xhigh, max |
| OpenCode | `provider/model` | A supported low, medium, high, or max variant |
| Gemini CLI | A supported Gemini model ID | Low: 1,024; medium: 4,096; high: 8,192 thinking tokens |

A blank model or **Default** effort uses the CLI's setting. Model support varies; use Default for Gemini models that do not accept a thinking budget. Summaries initially use Codex with `gpt-6-luna` and medium effort. Answers initially use the configured Codex model. Both choices can be changed independently.

Codex uses the existing `%USERPROFILE%\.codex\config.toml`, or `CODEX_HOME`. Its research adapter requires a `perplexity-litellm` MCP connector exposing `web_search` with structured citations. Other agents use built-in web search/fetch tools. Search availability depends on the CLI and provider.

Summary jobs disable tools. Research jobs restrict tools to search/fetch, and accepted source URLs must come from completed tool results. Generated owners, dates and evidence are checked against the transcript. Failed or unsourced research remains unresolved. Jobs can be cancelled and have a ten-minute timeout.

The app uses existing CLI authentication and does not change global credentials or configuration. You can select a native Codex `.exe` manually if discovery fails. **Test saved AI connections** uses synthetic content to check the selected agents.

## Transcripts and local storage

- Each session automatically saves a complete TXT document in the **scripts** folder beside the app. Choose another writable folder in settings when needed.
- **Saved transcripts / Load TXT** opens files from that folder; **Browse TXT** imports other files.
- Timed exports retain timestamps. Plain TXT passages use timestamp zero because timing metadata is absent.
- An unchanged automatic TXT file reopens its saved session, including checked actions and answers. External edits import as new sessions; automatic saving preserves changed content in separate `edited-…txt` copies.
- Session JSON and settings live under `%APPDATA%\Live Meeting Notes`. History and audio recovery use the JSON store.
- Transcript corrections invalidate notes and answers. Question corrections invalidate only that answer. Regeneration replaces notes, resets action completion and clears answers after successful saving; saved corrections, answers and checked actions trigger confirmation.
- Processed audio is deleted after successful transcript persistence. Pending audio retains timing journals for recovery. Missing or corrupt data remains marked incomplete.

TXT save errors are displayed without interrupting recording. Session JSON remains durable; TXT documents are rebuilt on the next startup.

## Privacy

Speech recognition runs on the PC. AI summaries send transcript context to the selected CLI's provider. Research sends the question and nearby passages to the selected agent and its search service.

Saved transcripts contain meeting information. Credentials, settings, recordings, generated transcripts, dependencies and build output are excluded by `.gitignore`. This repository contains application source, synthetic test fixtures and public-speech benchmark results.

## Build for Windows

```powershell
npm test
npm run dist:win
```

Prepare resources first if they are missing. Electron Builder creates the portable `dist\Live Meeting Notes 0.2.0.exe` and installer `dist\Live Meeting Notes Setup 0.2.0.exe`. Builds are unsigned; Windows or organizational policy may require signing or approval. The installer preserves local session data on uninstall.

## Tests and verification

```powershell
npm test
node scripts/benchmark.cjs --self-check
```

Tests cover audio chunking, Stop draining, recovery, atomic persistence and failures, agent validation, model/effort arguments, citation provenance, action completion, TXT imports and export content.

For isolated native Windows checks with generated audio:

```powershell
$env:MEETING_SMOKE_DATA = "$env:TEMP\live-meeting-notes-smoke"
$env:MEETING_SMOKE_PORT = '9237'
# First terminal, after preparing resources:
npx electron scripts/smoke-main.cjs --remote-debugging-port=9237
# Second terminal with the same environment variables:
node scripts/gui-smoke.cjs --synthetic --features --capture --close
```

AI checks use configured services. Debugging is enabled only by the explicit launch argument. See [verification results](docs/verification.md) for tested behavior and remaining hardware checks.

This version supports live English capture and TXT imports. Video-file import, Chinese transcription, speaker identification, Teams-only audio isolation and live summaries are not implemented.

## License

[MIT](LICENSE). Speech resources have separate notices in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
