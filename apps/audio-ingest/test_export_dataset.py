import importlib.util
import json
import tempfile
import unittest
import wave
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("export_dataset.py")
spec = importlib.util.spec_from_file_location("audio_ingest_export", MODULE_PATH)
export_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export_module)


class ExportTests(unittest.TestCase):
    def test_positive_export_crops_around_human_marked_occurrences(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "five-minutes.wav"
            samples = b"".join((index % 16000).to_bytes(2, "little") for index in range(16000 * 300))
            with wave.open(str(source), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(samples)
            row = {"clip_id": "clip_1", "label": "confirmed_positive", "session_id": "session_1",
                   "wake_word_occurrences": [10.0, 299.9], "sha256": "a" * 64}
            exported = export_module.write_positive_windows(source, root / "positive", row)
            self.assertEqual(len(exported), 2)
            for item in exported:
                path = root / "positive" / item["export_path"]
                with wave.open(str(path), "rb") as audio:
                    self.assertEqual(audio.getnframes(), 40_000)
                    self.assertEqual(audio.getframerate(), 16_000)
                    self.assertEqual(audio.getnchannels(), 1)
                self.assertTrue(path.with_suffix(".json").exists())
            self.assertEqual(json.loads((root / "positive" / "clip_1_occ_002.json").read_text())["occurrence_seconds"], 299.9)

    def test_unmarked_positive_is_not_exported_as_ground_truth(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "background.wav"
            with wave.open(str(source), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16_000)
                audio.writeframes(b"\x00\x00" * 16_000)
            result = export_module.write_positive_windows(source, root / "positive", {
                "clip_id": "clip_2", "label": "confirmed_positive", "wake_word_occurrences": []})
            self.assertEqual(result, [])


if __name__ == "__main__":
    unittest.main()
