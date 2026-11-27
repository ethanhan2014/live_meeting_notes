Tauri desktop release for **Apple Silicon Macs (M1 or later), macOS 12 or later**.

- Local, CPU-only WhisperX transcription with word alignment.
- Summaries and question answers through a local OpenAI-compatible proxy or Gemini API; no AI CLI required.
- Reusable API settings in an app-data .env file.
- Automatic Markdown transcripts, summaries, to-do lists, questions, answers, and completion flags.
- DMG installer and ZIP application archive, with SHA256 checksums.

Install Python 3.12 and the speech requirements separately, then select that interpreter in the app's settings. Configure your API endpoint, key, and model in the app. API keys are not included in this public release.

System audio requires BlackHole 2ch and a Multi-Output Device. Allow microphone access in macOS Privacy & Security settings. See the README for setup.

The app uses ad-hoc signing and is not notarized. Gatekeeper or managed policy may require approval. Intel Macs are not included because the current WhisperX/PyTorch dependencies do not provide Intel Mac wheels. Hardware capture and sustained meetings still require native verification.
