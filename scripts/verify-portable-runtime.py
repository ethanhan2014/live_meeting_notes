"""Check the shipped Python/CPU dependencies and prepare a short speech sample."""
import sys
import wave

import numpy as np
import soundcard
import torch
import torchcodec
import whisperx

assert torch.version.cuda is None, "Portable speech must use CPU-only PyTorch."
assert np.__version__ == "2.2.6", "SoundCard WASAPI needs the pinned NumPy version."
assert np.fromstring(b"\0\0\0\0", dtype=np.float32).size == 1
with wave.open(sys.argv[1], "rb") as source, wave.open(sys.argv[2], "wb") as target:
    target.setparams(source.getparams())
    target.writeframes(source.readframes(88000))
print("Bundled CPU WhisperX, TorchCodec, and SoundCard imports passed.")
