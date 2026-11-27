# Live Meeting Notes 0.4.0

Live meeting transcription with Tauri 2, local CPU/int8 WhisperX, and configurable OpenAI-compatible proxy or Gemini APIs. Transcripts, summaries, tasks, questions, and answers save automatically to Markdown. API settings persist in an app-data .env file.

## Windows 10/11 x64

Download the **portable.exe** and double-click it. There is no setup wizard or administrator requirement. Python 3.12, CPU-only PyTorch/WhisperX, shared FFmpeg, fixed WebView2, the base.en model, English alignment, and Silero VAD are bundled. First launch extracts the runtime to a versioned user cache under %LOCALAPPDATA%\Live Meeting Notes\portable. Allow several minutes and approximately 5 GB of free cache space. Choosing a different speech model downloads additional weights.

Enter your AI API details in the app. Public Windows downloads contain no API key. Meetings and saved configuration continue to use %APPDATA%\Live Meeting Notes. Windows binaries are unsigned. Physical microphone/loopback capture and sustained meetings remain manual checks.

## macOS 12+ Apple Silicon

Use the DMG or ZIP. Python/WhisperX remains a separate prerequisite, and system audio uses BlackHole 2ch with a Multi-Output Device. Intel Mac is unsupported by the current dependencies. Mac binaries use ad-hoc signatures and are not notarized.

See [macOS release notes](release-notes-macos.md) for installation and routing details.
