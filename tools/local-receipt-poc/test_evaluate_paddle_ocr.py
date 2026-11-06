import unittest

from evaluate_paddle_ocr import summarize_raw_result


class SummarizeRawResultTests(unittest.TestCase):
    def test_preserves_alignment_counts_and_confidence_summary(self):
        result = summarize_raw_result({
            "res": {
                "rec_texts": ["ПРОДУКТ", "70.54"],
                "rec_boxes": [[1, 2, 3, 4], [5, 6, 7, 8]],
                "rec_scores": [0.95, 0.85],
            }
        })
        self.assertEqual(result["text_region_count"], 2)
        self.assertEqual(result["box_count"], 2)
        self.assertEqual(result["confidence_count"], 2)
        self.assertEqual(result["mean_confidence"], 0.9)
        self.assertIn("raw arrays", result["reading_order"])

    def test_empty_result_is_explicit_and_does_not_claim_confidence(self):
        result = summarize_raw_result({})
        self.assertEqual(result["text_region_count"], 0)
        self.assertIsNone(result["mean_confidence"])
        self.assertIsNone(result["min_confidence"])


if __name__ == "__main__":
    unittest.main()
