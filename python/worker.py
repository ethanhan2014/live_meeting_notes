"""Private stdio worker: native capture and persistent WhisperX inference."""
import contextlib
import json
import math
import os
from pathlib import Path
import sys
import threading
import wave
from concurrent.futures import ThreadPoolExecutor

OUTPUT = sys.stdout
sys.stdout = sys.stderr  # Libraries must not corrupt the JSON protocol.
OUTPUT_LOCK = threading.Lock()

def emit(value):
    with OUTPUT_LOCK:
        OUTPUT.write(json.dumps(value, allow_nan=False) + "\n")
        OUTPUT.flush()

@contextlib.contextmanager
def audio_thread():
    if sys.platform != 'win32':
        yield
        return
    import ctypes
    # SoundCard initializes COM on import; Windows also requires it on this capture thread.
    ole32 = ctypes.WinDLL('ole32')
    if ole32.CoInitializeEx(None, 0) < 0:
        raise OSError('Could not initialize Windows COM for audio capture.')
    try:
        yield
    finally:
        ole32.CoUninitialize()

def normalize_segments(segments):
    result = []
    for segment in segments:
        start, end, text = segment["start"], segment["end"], segment["text"]
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (start, end)) or start < 0 or end < start or not isinstance(text, str):
            raise ValueError("WhisperX returned invalid transcript timing.")
        words = []
        original = segment.get("words", [])
        for index, word in enumerate(original):
            # Alignment cannot time some numbers/symbols; retain them between neighboring words.
            left = word.get("start", words[-1]["end"] if words else start)
            right = word.get("end", next((w["start"] for w in original[index + 1:] if "start" in w), end))
            if not isinstance(word.get("word"), str) or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (left, right)):
                raise ValueError("WhisperX returned invalid word timing.")
            left = min(end, max(start, left))
            words.append({"start": left, "end": min(end, max(left, right)), "word": " " + word["word"].strip()})
        result.append({"start": start, "end": end, "text": text, "words": words})
    return result

class Worker:
    def __init__(self):
        self.model = None
        self.capture_thread = None
        self.stop_event = threading.Event()
        self.capture_settings = {}

    def load(self, settings):
        import whisperx
        import torch
        device = 'cpu'
        if settings["speechModel"] not in ("base.en", "small.en", "medium.en", "large-v3"):
            raise ValueError("Invalid WhisperX model.")
        self.device = device
        self.batch_size = settings["batchSize"]
        threads = min(settings["threads"], os.cpu_count() or 1)
        torch.set_num_threads(threads)
        cache = str(Path(settings["cache"]).resolve())
        self.model = whisperx.load_model(settings["speechModel"], device, language="en", compute_type="int8", threads=threads, vad_method="silero", download_root=cache)
        self.align_model, self.metadata = whisperx.load_align_model(language_code="en", device=device, model_dir=cache)
        return {"ready": True}

    def transcribe(self, filename):
        import numpy as np
        import whisperx
        if self.model is None:
            raise RuntimeError("Load WhisperX before transcribing.")
        with wave.open(filename, "rb") as audio:
            if audio.getnchannels() != 1 or audio.getframerate() != 16000 or audio.getsampwidth() != 2 or not 0 < audio.getnframes() <= 96000:
                raise ValueError("Expected a mono 16-kHz PCM chunk of at most six seconds.")
            samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float32) / 32768
        result = self.model.transcribe(samples, batch_size=self.batch_size, language="en")
        if not result["segments"]:
            return []
        aligned = whisperx.align(result["segments"], self.align_model, self.metadata, samples, self.device, return_char_alignments=False)
        return normalize_segments(aligned["segments"])

    def devices(self):
        import soundcard as sc
        return [{"id": str(m.id), "name": m.name} for m in sc.all_microphones(include_loopback=False)]

    def start_capture(self, settings):
        import soundcard as sc
        self.stop_capture()
        microphones = sc.all_microphones(include_loopback=False)
        mic = next((m for m in microphones if str(m.id) == settings.get("microphone")), None) if settings.get("microphone") else sc.default_microphone()
        if sys.platform == "darwin":
            system = next((m for m in microphones if "blackhole" in m.name.lower()), None)
            if system is None:
                raise RuntimeError("Install BlackHole 2ch, route output through a Multi-Output Device, and allow microphone access in System Settings → Privacy & Security.")
        else:
            speaker = sc.default_speaker()
            system = sc.get_microphone(id=str(speaker.id), include_loopback=True) if speaker else None
        if mic is None or system is None or str(mic.id) == str(system.id):
            raise RuntimeError("Select a physical microphone and check the system output/loopback device.")
        self.capture_settings = settings.copy()
        self.stop_event.clear()
        opened = threading.Event()
        failures = []
        self.capture_thread = threading.Thread(target=self.capture, args=(mic, system, opened, failures), daemon=True)
        self.capture_thread.start()
        if not opened.wait(15):
            self.stop_event.set()
            raise RuntimeError("Audio devices did not open within 15 seconds. Check permissions.")
        if failures:
            self.stop_capture()
            raise RuntimeError(failures[0])

    def capture(self, mic, system, opened, failures):
        import numpy as np
        try:
            # WASAPI single-channel capture is unreliable; record all channels, then mix to mono.
            with audio_thread(), contextlib.ExitStack() as stack:
                inputs = [stack.enter_context(d.recorder(samplerate=16000, blocksize=1600)) for d in (mic, system)]
                while not self.stop_event.is_set():
                    raw_mic, raw_sys = [r.record(numframes=1600).mean(axis=1).astype(np.float32) for r in inputs]
                    settings = self.capture_settings
                    m = raw_mic * settings.get("micGain", 1) if not settings.get("muted") and not settings.get("paused") else np.zeros_like(raw_mic)
                    s = raw_sys * settings.get("systemGain", 1) if not settings.get("paused") else np.zeros_like(raw_sys)
                    mixed = m + s
                    if not np.isfinite(mixed).all():
                        raise RuntimeError("Audio device returned invalid samples.")
                    opened.set()
                    rms = lambda a: float(np.sqrt(np.mean(a * a)))
                    emit({"event": "audio", "value": {"pcm": np.clip(mixed, -1, 1).tolist(), "mic": rms(m), "system": rms(s), "rawMic": rms(raw_mic), "rawSystem": rms(raw_sys), "mixed": rms(mixed), "peak": float(np.max(np.abs(mixed)))}})
        except Exception as error:
            failures.append(str(error))
            emit({"event": "capture-error", "value": str(error)})
        finally:
            opened.set()

    def stop_capture(self):
        self.stop_event.set()
        if self.capture_thread:
            self.capture_thread.join(timeout=10)
            if self.capture_thread.is_alive():
                raise RuntimeError("Audio capture did not stop. Pending audio remains recoverable.")
            self.capture_thread = None

    def dispatch(self, method, value):
        if method == "load":
            return self.load(value)
        if method == "transcribe":
            return self.transcribe(value)
        if method == "devices":
            return self.devices()
        if method == "capture-start":
            return self.start_capture(value)
        if method == "capture-stop":
            return self.stop_capture()
        if method == "capture-settings":
            self.capture_settings = {**self.capture_settings, **value}
            return None
        raise ValueError("Unknown worker method.")

def main():
    worker = Worker()
    def respond(request):
        try:
            emit({"id": request["id"], "value": worker.dispatch(request["method"], request.get("value"))})
        except Exception as error:
            emit({"id": request["id"], "error": str(error)})
    # Inference is serial; capture controls remain responsive while a chunk is transcribed.
    with ThreadPoolExecutor(max_workers=1) as inference:
        try:
            for line in sys.stdin:
                if len(line) > 65536:
                    raise ValueError("Worker request too large.")
                request = json.loads(line)
                if request["method"] in ("load", "transcribe"):
                    inference.submit(respond, request)
                else:
                    respond(request)
        finally:
            worker.stop_capture()

if __name__ == "__main__":
    main()
