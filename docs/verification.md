# Verification record

## Version 0.3.0

Checked on 2026-11-04. Native builds use commit `bfbafbca65b1d65cfd3416da8bfe31811442973e`; the later documentation update does not change packaged application files. All three jobs passed in [desktop build run 41916581472](https://github.com/ethanhan2014/live_meeting_notes/actions/runs/41916581472).

| Platform | Passed tests | Skipped tests |
| --- | ---: | ---: |
| Linux development environment | 96 | 0 |
| Windows x64 | 91 | 5 |
| macOS Apple Silicon | 96 | 0 |
| macOS Intel x64 | 96 | 0 |

Windows skips cover POSIX executable discovery, process-group cancellation and symlink-replacement behavior. The suite additionally covers Mac CLI paths, Finder installation discovery, cancellation during configuration preparation, writable transcript storage outside the app bundle, denied/ended system audio, and CPU worker limits.

- Both Mac architectures recognized a generated English sentence with finite segment and word timing. A single inference took 3,183 ms on the Apple Silicon runner and 898 ms on the Intel runner. These short checks are not sustained meeting benchmarks.
- Both Mac DMG/ZIP builds passed ad-hoc signature verification, microphone/system audio privacy declarations, Mach-O architecture checks, bundled application byte comparisons, external schema comparisons, and speech resource hashes.
- Each packaged Mac app launched with an isolated profile, loaded the bundled English speech backend, and shut down successfully. This startup check did not exercise microphone/system audio hardware capture or authenticated AI generation.
- The Windows portable EXE built successfully and passed application/schema/resource verification. Its packaged GUI was not launched in this CI run.
- A four-core Linux check of the actual speech server reproduced scheduling slowdown with six workers: approximately 14.3 seconds versus 2.3 seconds with four workers on the same 5.5-second public speech sample. The app now limits workers to available cores; lower user limits are retained. Benchmark output reports the actual count.
- The benchmark self-check and Git whitespace checks passed. Gitleaks found no secrets in source or Git history.

Mac builds are ad-hoc signed and not notarized; Gatekeeper or managed policy may block them. Windows builds remain unsigned. Real Teams capture, headsets/Bluetooth, device hot-plug, multi-monitor recording, suspend, sustained meetings and authenticated Mac AI calls remain manual checks. No credentials, global AI CLI configuration or meeting data were changed.

---

The following historical record describes development checks performed before version 0.2.0 publication, checked on 2026-11-04. Meeting fixtures were synthetic; audio benchmarks used a short public speech sample or generated noise.

## Automated tests

- Linux: **86 passed**, no failures or skips.
- Windows: **85 passed**, no failures; one test requiring Unix symlink-replacement semantics was skipped.
- Covered audio chunking, overlap, final-buffer flushing, bounded shutdown, recovery without duplicate replay, atomic session and export writes, concurrent save ordering, agent and citation validation, model/effort arguments, action completion, TXT imports, and preservation of externally edited TXT files.
- The shutdown regression retains committed words and chunk IDs when a delayed save overlaps audio cleanup.

## Native Windows UI

An isolated profile and generated speech streamed into Web Audio were used without capturing a real microphone or playing speech through PC speakers.

- Agent/model/effort controls persisted independent summary and answer choices.
- Action checkboxes persisted and survived TXT reopening with existing notes and answers.
- Automatic TXT documents saved successfully. External plain TXT imported into a new session; unsafe filenames were rejected.
- Starting recording minimized the main window and opened the live transcript panel at the current monitor's right edge.
- Recognition continued while the main window was minimized. The panel's Stop button released capture tracks, saved six transcript segments, generated notes, and restored the full window.
- Earlier isolated checks covered audio testing without creating a session, silence calibration, mute/pause/resume, corrections, evidence display, history, and repeated recovery without duplicate data.

## AI integration

- Codex with `gpt-6-luna` and medium effort generated validated summaries.
- Claude Code with `sonnet` and low effort generated validated summaries and a researched answer with two validated source URLs.
- OpenCode command construction and event parsing have unit coverage; an installed runtime was unavailable for a native check.
- Gemini CLI options and thinking-budget settings were checked against installed CLI help and schemas. Live generation was blocked by a service-side `UNSUPPORTED_CLIENT` authentication rejection in the test installation.
- Codex research availability has varied between checks. An unavailable search tool produces an unresolved answer and explanation. Current successful native research evidence uses Claude Code.
- No credentials or global CLI configuration were changed for these checks.

## Speech benchmarks

Eight real inferences were measured per configuration on a six-second public speech sample in a Windows x64 CPU environment:

| Threads | VAD | p50 ms | p95 ms | Mean RTF |
| --- | --- | ---: | ---: | ---: |
| 2 | Off | 1830 | 2114 | 0.315 |
| 2 | On | 2983 | 3693 | 0.493 |
| 4 | Off | 2143 | 2356 | 0.361 |
| 4 | On | 2351 | 2565 | 0.388 |
| 6 | Off | 1965 | 2386 | 0.347 |
| 6 | On | 2073 | 2238 | 0.351 |

These measurements do not establish a universal optimum. Six threads remain the default. Thirty-minute arrival simulations cycled measured short-inference timings and showed zero backlog at 5.5-second arrivals; they were not thirty minutes of inference or a live meeting test. Raw results are in [benchmarks](benchmarks/threads-results.json).

Generated noise produced no text in either mode. VAD rejected pure noise faster but slowed noisy speech without an observed accuracy gain, so it remains off by default.

The pinned backend remaps VAD segment timestamps but not word timestamps. VAD mode drops word timing and uses segment overlap handling, which can repeat boundary words. VAD off retains token-based overlap trimming.

## Build and remaining checks

- Earlier packaging checks verified application files, external schemas, production dependencies, resource checksums, and portable/installer output.
- The current UI and agent changes were tested in the development app; updated packaged executables were not built or run for these changes.
- Real Teams meetings, headset/Bluetooth operation, device hot-plug, cross-monitor changes, suspend, hard power loss, and sustained long meetings remain hardware validation tasks.
- TXT/Markdown content and failed-replacement preservation pass automated checks. Native Save As dialogs worked in earlier checks, but the most recent dialog automation did not complete reliably.
