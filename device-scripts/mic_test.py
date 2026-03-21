import sounddevice as sd
import numpy as np

def callback(indata, frames, time, status):
    print(np.max(indata))

with sd.InputStream(callback=callback):
    input('Speak now...')

