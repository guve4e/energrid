import { mapRawLines } from './paddle-ocr.adapter';

describe('Paddle OCR evidence mapping', () => {
  it('keeps recognition order, text, confidence, and box coordinates unchanged', () => {
    expect(mapRawLines([{ res: {
      rec_texts: ['МЛЯКО 3.20', 'ОБЩО 3.20'],
      rec_boxes: [[1, 2, 30, 12], [1, 20, 30, 30]],
      rec_scores: [0.91, 0.98],
    }}])).toEqual([
      { id: 0, order: 0, text: 'МЛЯКО 3.20', confidence: 0.91, box: [1, 2, 30, 12] },
      { id: 1, order: 1, text: 'ОБЩО 3.20', confidence: 0.98, box: [1, 20, 30, 30] },
    ]);
  });

  it('rejects incomplete recognition evidence rather than fabricating coordinates or confidence', () => {
    expect(() => mapRawLines([{ rec_texts: ['TOTAL'], rec_boxes: [], rec_scores: [0.9] }])).toThrow(/incomplete/i);
  });
});
