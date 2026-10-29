# Local Receipt Intelligence POC — Lidl Bulgaria

**Status:** OCR and interpretation benchmarks completed; local interpretation candidates failed, while a separate text-only hybrid experiment produced a complete proposal.

**Scope:** The OCR and local-model evaluation used local processing. A separate hybrid experiment sent preserved OCR text (not the receipt image) to a cloud model. No receipt drafts, Finance records, database schemas, API processes, or Portal processes were changed.

## Result

PP-OCRv5 recognized the receipt's key financial evidence locally: printed date `2026-10-27`, final amount `€70.54`, a `€2.56` discount, and all 13 purchase-line amounts. The OCR-derived purchase lines sum to `€73.10`; applying the separately recognized discount gives `€70.54`. The receipt itself does not print a `€73.10` subtotal, so that figure is a calculation from recognized line amounts, not a printed summary field.

All nine quantity × unit-price rows were visually checked against their printed line totals and agreed to currency precision. The 13 purchase descriptions were recognized in reading order. A manual text comparison found 8/13 exact after normalizing punctuation and visually equivalent Latin/Cyrillic glyphs; character error rate was 7.98% before and 3.72% after that normalization. These are measurements for the 13 product-description rows only, not a whole-document accuracy score. Most remaining differences were mixed-script lookalikes or OCR confusion between similar glyphs. Currency symbols were sometimes read as a trailing `6`; the numeric amounts remained correct.

| Measure | Observed |
| --- | ---: |
| Purchase descriptions in reading order | 13 / 13 |
| Exact descriptions after glyph/punctuation normalization | 8 / 13 |
| Product-description CER | 7.98% raw; 3.72% normalized |
| Mean model confidence across all detected text regions | 0.8688 (not an accuracy score) |
| Date | Exact: 2026-10-27 |
| Final total | Exact: €70.54 |
| Purchase line amounts present | 13 / 13 |
| Quantity/unit-price arithmetic rows checked | 9 / 9 |
| Purchase sum, calculated from OCR values | €73.10 |
| Discount | Exact numeric amount: −€2.56 |
| Reconciliation | €73.10 − €2.56 = €70.54 |

## Runtime and model

- PaddleOCR 3.7.0, PaddlePaddle 3.2.1.
- `PP-OCRv5_mobile_det` with `cyrillic_PP-OCRv5_mobile_rec`, `lang=bg`.
- Apple M1 Pro, 16 GB unified memory, macOS 26.6.2; CPU inference, two CPU threads.
- The detail crop was 1,670 × 3,920 pixels. It was derived from the supplied image without changing receipt content; the original image was left untouched.
- Reproducible utility run: initialization 1.415 s; inference 16.996 s; total 18.411 s.
- Sampled RSS on that run: 189 MB before initialization, 909 MB after model load, 3.26 GB after inference. This is sampled process RSS, not a guaranteed peak measurement.
- Raw OCR JSON with all 99 text regions, boxes, scores, and recognition order is preserved outside the repository at `/private/tmp/energrid-local-receipt-poc/raw_ocr.json`.

On this Apple Silicon environment PaddlePaddle exposed CPU execution. Metal/GPU availability was not available to the inference process, so no accelerator result is claimed. The PaddleOCR server detector was attempted initially but exceeded the available execution memory/time budget; the mobile detector is the measured configuration.

## Local interpretation benchmark

The saved OCR JSON was reused as-is; its SHA-256 was `896f779388af47c0721ebbb17fead502f423d6bb2c1809d35355337b4385de7b`. Inference was local on an Apple M1 Pro using MLX-LM 0.24.0 / MLX 0.32.4 with an available Metal device. No cloud inference was called. The model outputs and provenance remain outside the repository under `/private/tmp/energrid-local-receipt-poc/interpreters/`.

| Candidate | Runtime | Inference | Sampled process RSS (loading / after inference where available) | Result on this receipt |
| --- | --- | ---: | ---: | --- |
| Qwen3-0.6B-4bit | MLX-LM 0.24.0, Metal | 8.39 s (1500-token run); 6.07 s (retry) | 643 MB / 474 MB; retry 651 MB / 665 MB | Returned only 1 purchase entry; date and currency were unknown. Incomplete coverage; failed. |
| Qwen3-1.7B-4bit | MLX-LM 0.24.0, Metal | 27.48 s (1500-token run); 99.38 s (6000-token retry) | 1,281 MB / 646 MB; retry 1,279 MB / 1,018 MB | First output was truncated. Retry over-extracted OCR regions as about 97 purchase-like entries and remained invalid/incomplete JSON. Failed. |
| Qwen3-4B-4bit | MLX-LM 0.24.0, Metal | 69.76 s | 321 MB before generation / 69 MB after generation (MLX device allocations are not represented by this process-RSS sample) | Parseable JSON, but it omitted the required schema version and was rejected. It contained only 1 purchase entry from a receipt with 13; currency was BGN rather than EUR; one amount was malformed (`2.56-6`) and the discount was returned as a percentage. Date and total were correct. Failed. |
| Qwen3-0.6B-Q4_0 | CPU-only llama.cpp build | About 151 s before stopping the incomplete run | Sampled child RSS about 1.68 GB | Stopped after four entries with invalid/incomplete JSON. Failed. |

No candidate achieved complete entry classification, purchase-line coverage, reliable quantity/price association, and exact reconciliation. Among the valid top-level fields produced by 4B, date and total matched; currency did not. Its malformed purchase and discount values cannot be passed as exact decimal strings. The Finance validator therefore must not mark that proposal reconciled. The 0.6B and 1.7B results did not produce a complete usable document. Detailed raw responses are retained outside this repository for local debugging; they are intentionally not copied into source control or this report.

The CPU-only test used a separately built llama.cpp command-line runtime because the available Python binding attempted to enable Metal during its source build. The Mac's MLX runtime did expose Metal when run on the Apple Silicon host. These results are device-specific sampled timings and memory, not a production performance promise.

## Adapter boundary and conclusion

`LocalDocumentUnderstandingAdapter` composes injected local OCR and local interpretation ports behind `DocumentUnderstandingPort`. It preserves cited OCR line IDs on extracted fields, rejects citations to nonexistent OCR lines, and routes output through the existing strict receipt validator and exact-decimal reconciliation. The later Receipt Review Integration V1 milestone registers this path as an opt-in NestJS provider; Python, PaddleOCR and MLX remain outside Finance Core. The benchmark runner is opt-in and writes raw OCR evidence, model proposal, raw response and runtime provenance as separate files.

The local pipeline is **not ready to replace the current provider**. The OCR stage has useful evidence quality, but the tested models failed receipt-level completeness and currency/amount correctness. Recommended next step: retain the existing OCR evidence and test a larger local instruction model with constrained structured decoding and a two-pass approach (row grouping/classification followed by typed field extraction). Keep Finance's decimal validator as the final gate. Do not connect this adapter to user receipt saving until a real receipt produces all 13 lines, the EUR currency and exact EUR 73.10 − EUR 2.56 = EUR 70.54 reconciliation.

## Hybrid text-only benchmark — GPT-5 mini

The preserved OCR text, line IDs, reading order, confidence and coordinates were sent to the OpenAI Responses API as text only. The source image was not sent. The run used structured JSON output, low reasoning effort, `store: false`, and the `gpt-5-mini` alias, which the API resolved to `gpt-5-mini-2025-08-07`. The model selection is an explicit runner argument; it is not built into Finance or its production adapter. The expected receipt values were used only for local benchmark comparison, never included in the prompt.

Two independent first-pass trials used identical OCR, model and settings (`max_output_tokens=6000`). Both stopped at the output-token limit and returned incomplete JSON, so neither produced a structured extraction. One correction pass received the original OCR, the second partial response and its deterministic validation errors, with a 10,000-token cap.

| Attempt | Latency | Input / cached input / output tokens | Estimated API cost | Result |
| --- | ---: | ---: | ---: | --- |
| Trial 1 | 61.642 s | 6,829 / 0 / 6,000 | $0.01370725 | Incomplete JSON at the output limit; no fields could be accepted. |
| Trial 2 | 55.269 s | 6,829 / 6,784 / 6,000 | $0.01218085 | Incomplete JSON at the output limit; no fields could be accepted. |
| One correction | 84.733 s | 12,028 / 1,792 / 7,160 | $0.01692380 | Complete JSON, but failed exact receipt interpretation and Finance validation. |
| **Total** | **201.644 s** | **25,686 / 8,576 / 19,160** | **$0.04281190** | Three API calls; the fourth-call ceiling was not used. |

The correction output reported the right article count of 13 but contained only 10 purchase entries. Three entries matched the reference quantity, unit-price and amount tuple; zero descriptions matched exactly. The proposed purchase amounts summed to €59.26, there was no discount entry, and there were no subtotal, final-total or payment entries. The reported total did match €70.54, leaving a deterministic difference of −€11.28. Its date was not valid ISO `YYYY-MM-DD`, the merchant did not match the reference, and the currency did not match EUR. The Finance receipt validator rejected it at the date field; no reconciled document was accepted.

The correction included 54 source references; all referenced IDs existed, and the amount strings were present in their cited OCR lines. This did not compensate for the missing lines or wrong classifications. The outcome is a failed benchmark, not a repaired or manually edited extraction. Raw responses, normalized validation summaries, token metadata and reference comparisons are stored with restrictive permissions outside Git at `/private/tmp/energrid-local-receipt-poc/hybrid-gpt5-mini-20261029/`.

The token-cost estimate uses the actual API usage and GPT-5 mini's published standard rates ($0.25 per million input tokens, $0.025 per million cached input tokens and $2 per million output tokens). It does not include account-specific adjustments or taxes. The API model page currently marks the dated GPT-5 mini snapshot as deprecated, though the alias used here returned successfully during this run.

## Boundary and reproducibility

The OCR and local interpretation scripts are at `tools/local-receipt-poc/evaluate_paddle_ocr.py` and `tools/local-receipt-poc/run_local_interpreter.py`. The benchmark runners remain opt-in utilities. The API integration described below reuses the OCR runner and does not add PaddleOCR, Python, MLX, or model-runtime dependencies to Finance Core.

Example, after installing the listed versions in a virtual environment outside the repository and obtaining the model artifacts:

```sh
python3.12 -m venv /path/outside/repo/receipt-venv
/path/outside/repo/receipt-venv/bin/pip install paddleocr==3.7.0 paddlepaddle==3.2.1 psutil
/path/outside/repo/receipt-venv/bin/python tools/local-receipt-poc/evaluate_paddle_ocr.py /path/to/receipt-crop.jpg \
  --output-dir /path/outside/repo/receipt-run \
  --model-cache /path/outside/repo/paddlex-cache \
  --cpu-threads 2
```

After the one-time package/model artifact setup, inference runs locally. The script does not call a hosted inference API.

To rerun interpretation without repeating OCR, point the script at the preserved `raw_ocr.json` and a locally downloaded MLX model directory:

```sh
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 /path/to/receipt-venv/bin/python tools/local-receipt-poc/run_local_interpreter.py \
  --ocr /path/outside/repo/raw_ocr.json \
  --model /path/outside/repo/models/qwen3-4b-4bit \
  --output-dir /path/outside/repo/interpreter-run \
  --max-tokens 6000 --temperature 0.2
```

The MLX runner requires Apple Silicon and a usable Metal device. The CPU-only llama.cpp experiment was separate; this runner is not a portable CPU fallback.

The model measurements above came from real local and text-only cloud inference, not mocked responses. The hybrid runner tests against the redacted reference fixture after inference; expected values are excluded from model input. Its offline validation utility test covers a valid proposal, an invented OCR reference and an unsupported amount. Adapter tests use synthetic OCR/proposal fixtures and verify source-reference validation plus Finance reconciliation; they do not represent model accuracy. No raw receipt OCR text or model response is committed to the repository.

Verification for the hybrid runner: its three offline validation scenarios passed; the focused receipt-domain/adapter suites passed (16 tests); TypeScript checks for the runner and its test passed; API build passed; `git diff --check` passed. The benchmark remains a developer tool and is not wired to receipt capture or Save.

## Receipt review integration

The receipt application can select the existing PaddleOCR PP-OCRv5 Bulgarian-compatible configuration using `PERSONAL_FINANCE_RECEIPT_PROVIDER=paddleocr-text`. OCR runs through the existing benchmark runner in a private temporary directory; `--offline` requires both model folders to already exist in the external PaddleX `official_models` cache. The Python runtime, packages, and model cache stay outside this repository. The OCR adapter deletes its temporary image and raw-output files after mapping recognized observations.

The text interpreter is an adapter over Energrid's configured `LlmGatewayService`, not a second conversation system. It receives OCR text, confidence, coordinates, reading order and account-owned category names, but not the receipt image. Provider and model use existing LLM configuration. Cloud mode still requires the Portal's explicit receipt consent. Structured proposals are validated for schema, evidence references and financial fields before mapping.

Full OCR observations are retained in the persisted receipt extraction JSON without a schema migration. Public receipt responses omit raw OCR observations. Before the Portal review, Receipt Intelligence calls `PersonalFinanceApplication.previewFinancialDocument` with the verified account context. That preview is read-only and does not authorize confirmation. Non-reconciled findings require explicit user acknowledgment, captured in the existing review audit event; existing Save checks still validate the reviewed amounts and receipt totals.

The existing provider remains the default (`openai-vision`). `paddleocr-text` is opt-in and requires `PERSONAL_FINANCE_PADDLE_PYTHON`, `PERSONAL_FINANCE_PADDLE_MODEL_CACHE`, cloud-enabled LLM mode, and the configured LLM provider/model. This wiring milestone used automated adapter fixtures; it did not run the live model or save a receipt. Acceptance still requires an authorized run using the actual Portal configuration.
