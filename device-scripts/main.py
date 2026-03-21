import os
import time
import json
import uuid
import wave
import queue
import pathlib
import threading
import base64
import subprocess
import platform

import numpy as np
import sounddevice as sd
import websocket
from openwakeword.model import Model

WS_URL = "ws://localhost:3101/voice"
BASE_DIR = pathlib.Path("./pi-agent-runtime")

RATE = 16000
CHANNELS = 1
BLOCKSIZE = 1280

WAKE_THRESHOLD = 0.97
WAKE_CONSECUTIVE_HITS = 3

SPEECH_RMS_THRESHOLD = 0.001
SILENCE_SECONDS = 1.5
MAX_STREAM_SECONDS = 10.0
COOLDOWN_SECONDS = 15.0
SPEECH_START_GRACE_SECONDS = 3.0
WAIT_FOR_REPLY_SECONDS = 12.0
GAIN = 4.0

STATE_IDLE = "idle"
STATE_STREAMING = "streaming"
STATE_WAITING_REPLY = "waiting_reply"

SESSIONS_DIR = BASE_DIR / "sessions"
LOG_FILE = BASE_DIR / "voice-agent.log"

BASE_DIR.mkdir(parents=True, exist_ok=True)
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def log(message: str):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


class VoiceAgent:
    def __init__(self):
        self.q = queue.Queue()
        self.model = Model()

        self.state = STATE_IDLE
        self.ws = None

        self.stream_started_at = 0.0
        self.last_speech_at = 0.0
        self.cooldown_until = 0.0
        self.reply_wait_started_at = 0.0
        self.speech_detected = False

        self.session_id = None
        self.session_started_iso = None
        self.session_audio_chunks = []
        self.last_wake_name = None
        self.last_wake_score = 0.0

        self.session_transcript = ""
        self.session_reply = ""
        self.session_conversation_id = None
        self.session_assistant_audio_file = None

        self.wake_candidate_name = None
        self.wake_candidate_hits = 0

    def audio_callback(self, indata, frames, time_info, status):
        if status:
            log(f"audio status: {status}")

        mono = indata[:, 0].copy()
        mono = np.clip(mono * GAIN, -1.0, 1.0)
        pcm16 = (mono * 32767).astype(np.int16)
        self.q.put(pcm16)

    def reset_wake_candidate(self):
        self.wake_candidate_name = None
        self.wake_candidate_hits = 0

    def _play_assistant_audio(self, audio_path: pathlib.Path):
        try:
            system = platform.system().lower()

            if system == "darwin":
                subprocess.run(["afplay", str(audio_path)], check=False)
            else:
                subprocess.run(["aplay", str(audio_path)], check=False)
        except Exception as e:
            log(f"assistant playback error: {e}")

    def _recv_loop(self):
        while self.ws:
            try:
                raw = self.ws.recv()
                if raw is None:
                    continue

                if isinstance(raw, bytes):
                    log(f"recv binary message: {len(raw)} bytes")
                    continue

                log(f"raw recv: {raw}")

                message = json.loads(raw)
                msg_type = message.get("type")
                log(f"recv: {msg_type}")

                if msg_type == "session_start":
                    self.session_conversation_id = message.get("conversationId")

                elif msg_type == "stt_partial":
                    pass

                elif msg_type == "stt_final":
                    self.session_transcript = message.get("text", "") or ""
                    log(f"stt_final: {self.session_transcript}")

                elif msg_type == "assistant_final":
                    self.session_reply = message.get("text", "") or ""
                    log(f"assistant_final: {self.session_reply}")

                elif msg_type == "assistant_audio":
                    audio_b64 = message.get("audioBase64", "") or ""
                    if audio_b64:
                        audio_bytes = base64.b64decode(audio_b64)

                        assistant_wav_path = (
                            SESSIONS_DIR
                            / f"{self.session_started_iso}_{self.session_id}_assistant.wav"
                        )

                        with open(assistant_wav_path, "wb") as f:
                            f.write(audio_bytes)

                        self.session_assistant_audio_file = assistant_wav_path.name
                        log(f"saved assistant wav: {assistant_wav_path}")

                        self._play_assistant_audio(assistant_wav_path)

                elif msg_type == "turn_end":
                    log("recv: turn_end")
                    self.close_ws()

                elif msg_type == "error":
                    log(f"server error: {message.get('message', 'unknown error')}")
                    self.close_ws()

            except Exception as e:
                log(f"recv loop ended: {e}")
                break

    def open_ws(self):
        log("opening ws")

        try:
            self.ws = websocket.WebSocket()
            self.ws.connect(WS_URL)

            self.state = STATE_STREAMING
            self.stream_started_at = time.time()
            self.last_speech_at = 0.0
            self.reply_wait_started_at = 0.0
            self.speech_detected = False

            self.session_id = str(uuid.uuid4())
            self.session_started_iso = time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())
            self.session_audio_chunks = []
            self.session_transcript = ""
            self.session_reply = ""
            self.session_conversation_id = None
            self.session_assistant_audio_file = None

            log(f"session started: {self.session_id}")

            threading.Thread(target=self._recv_loop, daemon=True).start()

        except Exception as e:
            log(f"ws open error: {e}")
            self.close_ws()

    def save_session_wav(self):
        if not self.session_audio_chunks or not self.session_id or not self.session_started_iso:
            return None

        wav_path = SESSIONS_DIR / f"{self.session_started_iso}_{self.session_id}.wav"

        try:
            with wave.open(str(wav_path), "wb") as wf:
                wf.setnchannels(CHANNELS)
                wf.setsampwidth(2)
                wf.setframerate(RATE)
                wf.writeframes(b"".join(self.session_audio_chunks))

            log(f"saved session wav: {wav_path}")
            return wav_path.name
        except Exception as e:
            log(f"save wav error: {e}")
            return None

    def save_session_json(self, user_wav_filename):
        if not self.session_id or not self.session_started_iso:
            return

        json_path = SESSIONS_DIR / f"{self.session_started_iso}_{self.session_id}.json"

        meta = {
            "sessionId": self.session_id,
            "conversationId": self.session_conversation_id,
            "startedAt": self.session_started_iso,
            "wakeWord": self.last_wake_name,
            "wakeScore": self.last_wake_score,
            "userText": self.session_transcript,
            "userAudioFile": user_wav_filename,
            "assistantText": self.session_reply,
            "assistantAudioFile": self.session_assistant_audio_file,
        }

        try:
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)

            log(f"saved session json: {json_path}")
        except Exception as e:
            log(f"save json error: {e}")

    def close_ws(self):
        ws = self.ws
        self.ws = None

        if ws:
            try:
                log("closing ws")
                ws.close()
            except Exception as e:
                log(f"ws close error: {e}")

        user_wav_filename = self.save_session_wav()
        self.save_session_json(user_wav_filename)

        self.state = STATE_IDLE
        self.cooldown_until = time.time() + COOLDOWN_SECONDS
        log(f"cooldown started for {COOLDOWN_SECONDS:.1f}s")

    def end_turn(self):
        if not self.ws:
            return

        try:
            log("sending end_of_turn")
            self.ws.send(json.dumps({"type": "end_of_turn"}))
            self.state = STATE_WAITING_REPLY
            self.reply_wait_started_at = time.time()
        except Exception as e:
            log(f"end_turn error: {e}")
            self.close_ws()

    def detect_wake(self, audio: np.ndarray):
        preds = self.model.predict(audio)

        best_name = None
        best_score = 0.0

        for name, score in preds.items():
            score = float(score)
            if score > best_score:
                best_name = name
                best_score = score

        if not best_name or best_score < WAKE_THRESHOLD:
            self.reset_wake_candidate()
            return False

        if self.wake_candidate_name == best_name:
            self.wake_candidate_hits += 1
        else:
            self.wake_candidate_name = best_name
            self.wake_candidate_hits = 1

        if self.wake_candidate_hits >= WAKE_CONSECUTIVE_HITS:
            self.last_wake_name = best_name
            self.last_wake_score = float(best_score)
            log(
                f"wake detected: {best_name} score={best_score:.3f} "
                f"hits={self.wake_candidate_hits}"
            )
            self.reset_wake_candidate()
            return True

        return False

    def calc_rms(self, audio: np.ndarray):
        f = audio.astype(np.float32) / 32768.0
        return float(np.sqrt(np.mean(np.square(f)) + 1e-12))

    def is_speech(self, audio: np.ndarray):
        rms = self.calc_rms(audio)
        if os.getenv("VOICE_AGENT_VERBOSE", "false").lower() == "true":
            log(f"rms={rms:.4f} state={self.state}")
        return rms >= SPEECH_RMS_THRESHOLD

    def run(self):
        log("voice agent started")

        with sd.InputStream(
            samplerate=RATE,
            channels=CHANNELS,
            dtype="float32",
            blocksize=BLOCKSIZE,
            callback=self.audio_callback,
        ):
            while True:
                audio = self.q.get()
                now = time.time()

                if self.state == STATE_IDLE:
                    if now < self.cooldown_until:
                        continue

                    if self.detect_wake(audio):
                        self.open_ws()

                    continue

                if self.state == STATE_WAITING_REPLY:
                    waited = now - self.reply_wait_started_at
                    if waited >= WAIT_FOR_REPLY_SECONDS:
                        log(f"reply timeout: {waited:.2f}s")
                        self.close_ws()
                    continue

                audio_bytes = audio.tobytes()
                self.session_audio_chunks.append(audio_bytes)

                try:
                    self.ws.send(audio_bytes, opcode=websocket.ABNF.OPCODE_BINARY)
                except Exception as e:
                    log(f"ws send error: {e}")
                    self.close_ws()
                    continue

                if self.is_speech(audio):
                    self.last_speech_at = now
                    if not self.speech_detected:
                        self.speech_detected = True
                        log("speech detected")

                total_for = now - self.stream_started_at

                if not self.speech_detected:
                    if total_for >= SPEECH_START_GRACE_SECONDS:
                        log(f"no speech detected within {SPEECH_START_GRACE_SECONDS:.1f}s")
                        self.close_ws()
                        continue
                else:
                    silence_for = now - self.last_speech_at
                    if silence_for >= SILENCE_SECONDS:
                        log(f"silence timeout: {silence_for:.2f}s")
                        self.end_turn()
                        continue

                if total_for >= MAX_STREAM_SECONDS:
                    log(f"hard timeout: {total_for:.2f}s")
                    self.end_turn()
                    continue


if __name__ == "__main__":
    while True:
        try:
            VoiceAgent().run()
        except Exception as e:
            log(f"agent crash: {e}")
            time.sleep(2)
