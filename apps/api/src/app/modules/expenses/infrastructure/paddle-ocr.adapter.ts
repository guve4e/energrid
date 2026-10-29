import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LocalOcrLine, LocalReceiptOcrPort } from './local-document-understanding.adapter';

const MAX_STDIO = 2 * 1024 * 1024;
const OCR_TIMEOUT_MS = 120_000;

/** Runs the already-benchmarked PaddleOCR runner locally and keeps transient files private. */
export class PaddleOcrAdapter implements LocalReceiptOcrPort {
  async recognize(image: { bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' }) {
    const python = process.env.PERSONAL_FINANCE_PADDLE_PYTHON?.trim();
    const cache = process.env.PERSONAL_FINANCE_PADDLE_MODEL_CACHE?.trim();
    if (!python || !cache) throw new Error('Local receipt OCR is not configured; set its Python runtime and external model cache.');
    const resolvedCache = await realpath(cache).catch(() => null);
    if (!resolvedCache || !isOutsideRepository(resolvedCache)) throw new Error('The PaddleOCR model cache must exist outside the repository.');
    const script = resolve(process.env.PERSONAL_FINANCE_PADDLE_OCR_SCRIPT?.trim() || join(process.cwd(), 'tools/local-receipt-poc/evaluate_paddle_ocr.py'));
    const workspace = await mkdtemp(join(tmpdir(), 'energrid-receipt-ocr-'));
    await chmod(workspace, 0o700);
    const inputDir = join(workspace, 'input');
    const outputDir = join(workspace, 'output');
    await mkdir(inputDir, { mode: 0o700 });
    await mkdir(outputDir, { mode: 0o700 });
    const imagePath = join(inputDir, image.mediaType === 'image/jpeg' ? 'receipt.jpg' : 'receipt.png');
    try {
      await writeFile(imagePath, Buffer.from(image.bytes), { mode: 0o600, flag: 'wx' });
      await this.run(python, [script, imagePath, '--output-dir', outputDir, '--model-cache', resolvedCache, '--offline']);
      const raw = JSON.parse(await readFile(join(outputDir, 'raw_ocr.json'), 'utf8')) as unknown;
      const metrics = JSON.parse(await readFile(join(outputDir, 'metrics.json'), 'utf8')) as Record<string, unknown>;
      return {
        provider: 'paddleocr',
        model: `${String(metrics.detection_model ?? 'PP-OCRv5_mobile_det')}+${String(metrics.recognition_model ?? 'cyrillic_PP-OCRv5_mobile_rec')}`,
        lines: mapRawLines(raw),
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  private run(command: string, args: string[]) {
    return new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PADDLE_PDX_CACHE_HOME: process.env.PERSONAL_FINANCE_PADDLE_MODEL_CACHE,
          PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let outputBytes = 0;
      let errorBytes = 0;
      let output = '';
      let errorOutput = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), OCR_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_STDIO) child.kill('SIGKILL');
        else output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errorBytes += chunk.length;
        if (errorBytes > MAX_STDIO) child.kill('SIGKILL');
        else errorOutput += chunk.toString('utf8');
      });
      child.once('error', (error) => { clearTimeout(timer); rejectRun(new Error(`Could not start local receipt OCR: ${error.message}`)); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolveRun();
        else {
          const reason = signal === 'SIGKILL' ? 'timed out or exceeded its output limit' : `exited with status ${code}`;
          // Provider logs can contain receipt text. Return only a generic failure to callers.
          void output; void errorOutput;
          rejectRun(new Error(`Local receipt OCR ${reason}. Check the local runtime and model cache.`));
        }
      });
    });
  }
}

export function mapRawLines(value: unknown): LocalOcrLine[] {
  if (!Array.isArray(value) || !value.length || !value[0] || typeof value[0] !== 'object') throw new Error('Local OCR returned no observation data.');
  const result = (value[0] as { res?: Record<string, unknown> }).res ?? value[0] as Record<string, unknown>;
  const texts = result.rec_texts;
  const boxes = result.rec_boxes ?? result.dt_polys;
  const scores = result.rec_scores;
  if (!Array.isArray(texts) || !Array.isArray(boxes) || !Array.isArray(scores) || !texts.length || texts.length !== boxes.length || texts.length !== scores.length) {
    throw new Error('Local OCR text, coordinates, and confidence evidence are incomplete.');
  }
  return texts.map((text, id) => {
    const box = Array.from(boxes[id] as ArrayLike<unknown>, Number);
    const score = Number(scores[id]);
    if (typeof text !== 'string' || box.length < 4 || box.some((value) => !Number.isFinite(value))) throw new Error('Local OCR returned malformed observation data.');
    return { id, order: id, text, confidence: Number.isFinite(score) && score >= 0 && score <= 1 ? score : null, box };
  });
}

function isOutsideRepository(path: string) {
  const repo = resolve(process.cwd());
  return path !== repo && !path.startsWith(`${repo}/`);
}
