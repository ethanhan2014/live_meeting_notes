import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "load":
        result = {"ready": True}
    elif method == "transcribe":
        result = [{"start": 0, "end": 1, "text": "Hello world", "words": [{"start": 0, "end": 1, "word": " Hello world"}]}]
    elif method == "capture-stop":
        print(json.dumps({"event": "audio", "value": {"pcm": [0.1, 0.2]}}), flush=True)
        result = None
    elif method == "devices":
        result = [{"id": "mic", "name": "Microphone"}]
    else:
        print(json.dumps({"id": request["id"], "error": "Unknown method"}), flush=True)
        continue
    print(json.dumps({"id": request["id"], "value": result}), flush=True)
