import importlib.util
import io
import json
import threading
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[1] / "python" / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class WorkerTests(unittest.TestCase):
    def test_model_initializes_on_the_reader_thread_and_inference_stays_in_background(self):
        calls = {}
        owner = threading.current_thread()
        class FakeWorker:
            def dispatch(self, method, value):
                calls[method] = threading.current_thread()
            def stop_capture(self):
                pass
        requests = io.StringIO(''.join(json.dumps({'id': i, 'method': method}) + '\n' for i, method in enumerate(['load', 'transcribe'])))
        with patch.object(worker, 'Worker', FakeWorker), patch.object(worker.sys, 'stdin', requests), patch.object(worker, 'emit'):
            worker.main()
        self.assertIs(calls['load'], owner)
        self.assertIsNot(calls['transcribe'], owner)

    def test_model_and_alignment_use_cpu_even_with_an_old_cuda_preference(self):
        calls = []
        def load_model(model, device, **options):
            calls.append((device, options['compute_type']))
            return object()
        def load_align_model(**options):
            calls.append(options['device'])
            return object(), {}
        with patch.dict(worker.sys.modules, {'whisperx': SimpleNamespace(load_model=load_model, load_align_model=load_align_model), 'torch': SimpleNamespace(set_num_threads=lambda n: None)}):
            value = worker.Worker()
            value.load({'speechDevice': 'cuda', 'speechModel': 'base.en', 'threads': 2, 'batchSize': 4, 'cache': '/tmp/models'})
        self.assertEqual(calls, [('cpu', 'int8'), 'cpu'])

    def test_alignment_keeps_spaces_and_untimed_words(self):
        segments = worker.normalize_segments([{"start": 0, "end": 2, "text": "Pay £13.60 today", "words": [{"word": "Pay", "start": 0, "end": .5}, {"word": "£13.60"}, {"word": "today", "start": 1, "end": 2}]}])
        self.assertEqual(''.join(w["word"] for w in segments[0]["words"]).strip(), "Pay £13.60 today")
        self.assertEqual(segments[0]["words"][1]["start"], .5)

    def test_invalid_timing_is_rejected(self):
        for segment in [{"start": float('nan'), "end": 1, "text": "Hi"}, {"start": 2, "end": 1, "text": "Hi"}]:
            with self.assertRaises(ValueError):
                worker.normalize_segments([segment])

    def test_empty_speech_does_not_align(self):
        self.assertEqual(worker.normalize_segments([]), [])

    def test_windows_capture_initializes_com_on_its_own_thread(self):
        calls = []
        class Ole32:
            def CoInitializeEx(self, pointer, mode):
                calls.append('initialize')
                return 0
            def CoUninitialize(self):
                calls.append('uninitialize')
        with patch.object(worker.sys, 'platform', 'win32'), patch('ctypes.WinDLL', return_value=Ole32(), create=True):
            with self.assertRaisesRegex(RuntimeError, 'device failed'):
                with worker.audio_thread():
                    raise RuntimeError('device failed')
        self.assertEqual(calls, ['initialize', 'uninitialize'])

if __name__ == "__main__":
    unittest.main()
