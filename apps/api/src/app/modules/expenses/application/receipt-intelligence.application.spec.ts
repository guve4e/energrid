import { ReceiptIntelligenceApplication } from './receipt-intelligence.application';
import type { ReceiptExtractionV1 } from '../domain/receipt-extraction.types';

const field = <T>(value: T | null) => ({ value, confidence: value === null ? null : 0.9, uncertainty: null, sourceText: value === null ? null : String(value) });
const extraction: ReceiptExtractionV1 = {
  schemaVersion: 'receipt-extraction-v1', documentType: field('receipt'), merchant: field('Lidl'), date: field('2026-10-28'), time: field(null), currency: field('EUR'),
  subtotal: field('3'), taxTotal: field(null), discountTotal: field(null), depositTotal: field(null), total: field('3'), reportedArticleCount: field(null), adjustments: [], sourceText: 'Yogurt 3.00', warnings: [],
  items: [{ originalDescription: field('Yogurt'), normalizedDescription: field('Yogurt'), quantity: field('1'), unit: field('each'), packaging: field(null), unitPrice: field('3'), lineTotal: field('3'), discount: field('0'), tax: field('0'), taxIncluded: field(true), suggestedCategory: field('Groceries') }],
};

describe('receipt intelligence application', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const context = { accountId: 'account-a', actorId: 'account-a' };
  const metadata = (storageKey = 'account-a/file.jpg', contentHash = 'hash', storedExtraction = extraction) => ({ id: 'receipt-1', accountId: 'account-a', draftId: 'draft-1', expenseId: null, contentHash, mediaType: 'image/jpeg', byteLength: 4, storageKey, status: 'review_required', extractedTotals: { subtotal: '3', tax: null, discount: null, total: '3', currency: 'EUR' }, parserProvider: 'test', parserModel: 'vision', extraction: storedExtraction, createdAt: '2026-10-28T10:00:00.000Z' });

  function setup() {
    const categories = [
      { id: 'category-groceries', accountId: 'account-a', name: 'Groceries', description: null, parentId: null, status: 'active', createdAt: '', updatedAt: '', archivedAt: null },
      { id: 'category-fuel', accountId: 'account-a', name: 'Fuel', description: null, parentId: null, status: 'active', createdAt: '', updatedAt: '', archivedAt: null },
    ];
    const repository = {
      listCategories: jest.fn().mockResolvedValue(categories),
      findReceiptByHash: jest.fn().mockResolvedValue(null), createDraft: jest.fn().mockImplementation(async (_account, _actor, proposal) => ({ id: 'draft-1', accountId: 'account-a', status: 'proposed', ...proposal, receipts: [metadata(proposal.receipts[0].storageKey, proposal.receipts[0].contentHash, proposal.receipts[0].extraction)] })),
      getDraft: jest.fn(), findPossibleReceiptMatches: jest.fn().mockResolvedValue([]), getReceipt: jest.fn().mockResolvedValue(metadata()),
      replaceReceiptExtraction: jest.fn(), markReceiptDocumentDeleted: jest.fn(),
      updateDraft: jest.fn(), attachReceiptToExpense: jest.fn(), reopenRejectedReceiptDraft: jest.fn(),
    } as any;
    const understanding = { extract: jest.fn().mockResolvedValue({ extraction, provider: 'test', model: 'vision' }) };
    const storage = { put: jest.fn().mockResolvedValue('account-a/file.jpg'), get: jest.fn().mockResolvedValue(bytes), delete: jest.fn().mockResolvedValue(undefined) };
    const finance = { previewFinancialDocument: jest.fn().mockReturnValue({ schemaVersion: 'financial-document-preview-v1', status: 'needs_review' }) };
    return { app: new ReceiptIntelligenceApplication(repository, understanding, storage, finance as any), repository, understanding, storage, categories, finance };
  }

  it('requires explicit consent and image content/type agreement before inference', async () => {
    const { app, understanding, storage } = setup();
    await expect(app.extract(context, bytes, 'image/jpeg', false)).rejects.toThrow(/consent/);
    await expect(app.extract(context, bytes, 'image/png', true)).rejects.toThrow(/does not match/);
    expect(understanding.extract).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('creates a reviewable draft and stores the image privately without confirming an expense', async () => {
    const { app, repository, understanding, storage } = setup();
    const result = await app.extract(context, bytes, 'image/jpeg', true);
    expect(understanding.extract).toHaveBeenCalledWith({ bytes, mediaType: 'image/jpeg' }, { cloudDataConsent: true, categories: ['Groceries', 'Fuel'] });
    expect(storage.put).toHaveBeenCalledWith('account-a', 'image/jpeg', bytes);
    expect(repository.createDraft).toHaveBeenCalledWith('account-a', 'account-a', expect.objectContaining({ sourceKind: 'receipt', amount: '3', currency: 'EUR' }));
    expect(result).toMatchObject({ duplicate: false, draft: { id: 'draft-1', status: 'proposed' } });
    expect(result.extractionDiagnostics).toMatchObject({ responseStatus: 'completed', modelItemCount: 1, validatedItemCount: 1, persistedExtractionItemCount: 1, completeDraftItemCount: 1, incompleteExtractionItemCount: 0, completeButUnmappedItemCount: 0 });
    expect(repository.createDraft.mock.calls[0][2]).toMatchObject({ category: 'Groceries', items: [{ categoryId: 'category-groceries' }] });
    expect(repository).not.toHaveProperty('confirmDraft');
  });

  it('calls the independent Finance preview with the OCR evidence before returning the review result', async () => {
    const { app, understanding, finance } = setup();
    const evidence = [{ id: 0, order: 0, text: 'LIDL' }, { id: 1, order: 1, text: 'Yogurt 3.00' }, { id: 2, order: 2, text: 'Total 3.00' }];
    const extracted = {
      schemaVersion: 'receipt-extraction-v1.1', documentType: { ...field('receipt'), sourceLineIds: [0] },
      merchant: { ...field('Lidl'), sourceLineIds: [0] }, date: { ...field('2026-10-28'), sourceLineIds: [0] }, time: field(null),
      currency: { ...field('EUR'), sourceLineIds: [2] }, subtotal: field(null), taxTotal: field(null), discountTotal: field(null), depositTotal: field(null),
      total: { ...field('3.00'), sourceLineIds: [2] }, reportedArticleCount: field(null), sourceText: 'LIDL\nYogurt 3.00\nTotal 3.00', warnings: [],
      ocrEvidence: { provider: 'paddleocr', model: 'pp-ocrv5', lines: evidence.map((line) => ({ ...line, confidence: 0.95, box: [0, line.id * 10, 20, line.id * 10 + 8] })) },
      entries: [
        previewEntry('purchase', 'Yogurt', '3.00', 1),
        previewEntry('final_total', 'Total', '3.00', 2),
      ],
    };
    understanding.extract.mockResolvedValue({ extraction: extracted as any, provider: 'local:paddleocr+openai', model: 'gpt-5.5' });

    const result = await app.extract(context, bytes, 'image/jpeg', true);

    expect(finance.previewFinancialDocument).toHaveBeenCalledWith(context, expect.objectContaining({
      schemaVersion: 'financial-document-interpretation-v1', evidence, extraction: expect.objectContaining({
        ocrEvidence: expect.objectContaining({ lines: expect.arrayContaining([expect.objectContaining({ confidence: 0.95, box: [0, 10, 20, 18] })]) }),
      }),
    }));
    expect(result.preview).toMatchObject({ status: 'needs_review' });
  });

  it('returns backend reconciliation when an authenticated owner reopens an existing receipt draft', async () => {
    const { app, repository } = setup();
    repository.getDraft.mockResolvedValue({ id: 'draft-1', accountId: 'account-a', receipts: [metadata()] } as any);
    await expect(app.getDraft(context, 'draft-1')).resolves.toMatchObject({ draft: { id: 'draft-1' }, reconciliation: { matched: true, itemTotal: '3', total: '3', difference: '0' } });
    expect(repository.getDraft).toHaveBeenCalledWith('account-a', 'draft-1');
  });

  it('reports model, validated, persisted, and normalized item counts without hiding dropped incomplete lines', async () => {
    const { app, understanding } = setup();
    const incomplete = { ...extraction.items[0], lineTotal: field(null), unitPrice: field(null) };
    const twoLineExtraction = { ...extraction, total: field('70.54'), reportedArticleCount: field(13), items: [extraction.items[0], incomplete] };
    understanding.extract.mockResolvedValue({ extraction: twoLineExtraction, provider: 'test', model: 'vision' });
    const result = await app.extract(context, bytes, 'image/jpeg', true);
    expect(result.extractionDiagnostics).toMatchObject({ modelItemCount: 2, validatedItemCount: 2, persistedExtractionItemCount: 2, completeDraftItemCount: 1, incompleteExtractionItemCount: 1, completeButUnmappedItemCount: 0, reportedArticleCount: 13 });
    expect(result.reconciliation).toMatchObject({ matched: null, extractedLineCount: 2, completeLineCount: 1, incompleteLineCount: 1, reportedArticleCount: 13 });
  });

  it('re-extracts into the same private receipt and draft without creating a duplicate expense', async () => {
    const { app, repository, understanding, storage } = setup();
    repository.getDraft.mockResolvedValue({ id: 'draft-1', status: 'needs_review' } as any);
    repository.replaceReceiptExtraction.mockImplementation(async (_account, _actor, receiptId, input) => ({
      id: 'draft-1', accountId: 'account-a', status: 'needs_review', date: input.date, amount: input.amount, currency: input.currency,
      merchantName: input.merchantName, category: null, description: input.merchantName, tags: [], sourceKind: 'receipt', sourceId: 'receipt:sha256:hash',
      extractionProvider: 'test', extractionModel: 'vision', items: input.items,
      receipts: [{ ...metadata(), id: receiptId, extraction: input.extraction }], createdAt: '', updatedAt: '',
    } as any));
    const result = await app.reextract(context, 'receipt-1', true);
    expect(storage.get).toHaveBeenCalledWith('account-a', 'account-a/file.jpg');
    expect(understanding.extract).toHaveBeenCalledWith({ bytes, mediaType: 'image/jpeg' }, { cloudDataConsent: true, categories: ['Groceries', 'Fuel'] });
    expect(repository.replaceReceiptExtraction).toHaveBeenCalledWith('account-a', 'account-a', 'receipt-1', expect.objectContaining({ extraction, amount: '3', category: 'Groceries', items: expect.arrayContaining([expect.objectContaining({ categoryId: 'category-groceries' })]) }));
    expect(repository.createDraft).not.toHaveBeenCalled();
    expect(result.draft.id).toBe('draft-1');
    expect(result.receipt.id).toBe('receipt-1');
  });

  it('requires fresh cloud consent and refuses to replace a reviewed receipt', async () => {
    const { app, repository, understanding } = setup();
    await expect(app.reextract(context, 'receipt-1', false)).rejects.toThrow(/consent/);
    repository.getReceipt.mockResolvedValue({ ...metadata(), userReviewedAt: '2026-10-28T12:00:00Z' });
    await expect(app.reextract(context, 'receipt-1', true)).rejects.toThrow(/unreviewed/);
    expect(understanding.extract).not.toHaveBeenCalled();
    expect(repository.replaceReceiptExtraction).not.toHaveBeenCalled();
  });

  it('returns an exact account-scoped duplicate without a second inference or storage write', async () => {
    const { app, repository, understanding, storage } = setup();
    repository.findReceiptByHash.mockResolvedValue(metadata());
    const result = await app.extract(context, bytes, 'image/jpeg', true);
    expect(result).toMatchObject({ duplicate: true, receipt: { id: 'receipt-1' } });
    expect(understanding.extract).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('reopens a previously rejected same-image draft without creating a second receipt', async () => {
    const { app, repository, understanding, storage } = setup();
    repository.findReceiptByHash.mockResolvedValue(metadata());
    repository.getDraft.mockResolvedValue({ id: 'draft-1', status: 'rejected' });
    repository.reopenRejectedReceiptDraft.mockResolvedValue({ id: 'draft-1', status: 'needs_review' });
    const result = await app.extract(context, bytes, 'image/jpeg', true);
    expect(repository.reopenRejectedReceiptDraft).toHaveBeenCalledWith('account-a', 'account-a', 'receipt-1');
    expect(result).toMatchObject({ duplicate: true, draft: { id: 'draft-1', status: 'needs_review' } });
    expect(understanding.extract).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('does not persist an image when the provider fails', async () => {
    const { app, storage, understanding } = setup();
    understanding.extract.mockRejectedValue(new Error('provider unavailable'));
    await expect(app.extract(context, bytes, 'image/jpeg', true)).rejects.toThrow('provider unavailable');
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('maps content category suggestions only to active categories owned by the account', async () => {
    const { app, repository, understanding } = setup();
    const foreignSuggestion = { ...extraction.items[0], suggestedCategory: field('Construction') };
    const mixed = { ...extraction, items: [extraction.items[0], foreignSuggestion] };
    understanding.extract.mockResolvedValue({ extraction: mixed, provider: 'test', model: 'vision' });
    const result = await app.extract(context, bytes, 'image/jpeg', true);
    const proposal = repository.createDraft.mock.calls[0][2];
    expect(proposal.category).toBe('Groceries');
    expect(proposal.items.map((item: any) => item.categoryId)).toEqual(['category-groceries', null]);
    expect(proposal.receipts[0].extraction.items.map((item: any) => item.suggestedCategory.value)).toEqual(['Groceries', null]);
    expect(result.draft.status).toBe('proposed');
  });

  it('deletes the unreferenced image when draft validation fails before persistence', async () => {
    const { app, repository, storage, understanding } = setup();
    understanding.extract.mockResolvedValue({ extraction: { ...extraction, total: field('0') }, provider: 'test', model: 'vision' });

    await expect(app.extract(context, bytes, 'image/jpeg', true)).rejects.toThrow('amount must be greater than zero');

    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(repository.createDraft).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledWith('account-a', 'account-a/file.jpg');
  });

  it('keeps the image when a failed draft write has no confirmed persisted receipt', async () => {
    const { app, repository, storage } = setup();
    repository.createDraft.mockRejectedValue(new Error('database unavailable'));
    await expect(app.extract(context, bytes, 'image/jpeg', true)).rejects.toThrow('database unavailable');
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(repository.findReceiptByHash).toHaveBeenCalledTimes(2);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('deletes only the unused image when a failed write resolves to a different persisted key', async () => {
    const { app, repository, storage } = setup();
    repository.createDraft.mockRejectedValue(new Error('write failed'));
    repository.findReceiptByHash
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(metadata('account-a/existing.jpg'));

    await expect(app.extract(context, bytes, 'image/jpeg', true)).rejects.toThrow('write failed');

    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('account-a', 'account-a/file.jpg');
  });

  it('keeps a committed draft image if the later possible-match lookup fails', async () => {
    const { app, repository, storage } = setup();
    repository.findPossibleReceiptMatches.mockRejectedValue(new Error('match lookup unavailable'));

    await expect(app.extract(context, bytes, 'image/jpeg', true)).rejects.toThrow('match lookup unavailable');

    expect(repository.createDraft).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalled();

    const contentHash = repository.createDraft.mock.calls[0][2].receipts[0].contentHash;
    repository.findReceiptByHash.mockResolvedValueOnce(metadata('account-a/file.jpg', contentHash));
    repository.getDraft.mockResolvedValue({ id: 'draft-1', status: 'needs_review', receipts: [metadata('account-a/file.jpg', contentHash)] });
    const retry = await app.extract(context, bytes, 'image/jpeg', true);
    expect(retry).toMatchObject({ duplicate: true, draft: { id: 'draft-1' } });
    expect(repository.createDraft).toHaveBeenCalledTimes(1);
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed image when draft persistence returns an ambiguous error', async () => {
    const { app, repository, storage } = setup();
    repository.createDraft.mockRejectedValue(new Error('commit acknowledgement lost'));
    repository.findReceiptByHash
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(metadata('account-a/file.jpg'));

    await expect(app.extract(context, bytes, 'image/jpeg', true)).rejects.toThrow('commit acknowledgement lost');

    expect(repository.findReceiptByHash).toHaveBeenCalledTimes(2);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('keeps the image if draft persistence outcome cannot be checked', async () => {
    const { app, repository, storage } = setup();
    repository.createDraft.mockRejectedValue(new Error('database unavailable'));
    repository.findReceiptByHash
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('database still unavailable'));

    await expect(app.extract(context, bytes, 'image/jpeg', true)).rejects.toThrow('database unavailable');

    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('does not delete an image if the committed draft response omits its receipt', async () => {
    const { app, repository, storage } = setup();
    repository.createDraft.mockResolvedValue({ id: 'draft-1', receipts: [] });

    await expect(app.extract(context, bytes, 'image/jpeg', true)).rejects.toThrow(/did not return its receipt/);

    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('removes only the unused image when another concurrent upload has already created the draft', async () => {
    const { app, repository, storage } = setup();
    repository.createDraft.mockImplementation(async (_account: string, _actor: string, proposal: any) => ({
      id: 'draft-existing', receipts: [metadata('account-a/existing.jpg', proposal.receipts[0].contentHash)],
    }));

    const result = await app.extract(context, bytes, 'image/jpeg', true);

    expect(result).toMatchObject({ duplicate: true, draft: { id: 'draft-existing' } });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('account-a', 'account-a/file.jpg');
  });

  it('retries an already marked receipt deletion with account scope', async () => {
    const { app, repository, storage } = setup();
    const marked = { ...metadata(), documentDeletedAt: '2026-10-28T13:00:00.000Z' };
    repository.markReceiptDocumentDeleted.mockResolvedValue(marked);

    await expect(app.deleteImage(context, 'receipt-1')).resolves.toEqual(marked);
    await expect(app.deleteImage(context, 'receipt-1')).resolves.toEqual(marked);

    expect(repository.markReceiptDocumentDeleted).toHaveBeenCalledTimes(2);
    expect(repository.markReceiptDocumentDeleted).toHaveBeenCalledWith('account-a', 'account-a', 'receipt-1');
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(storage.delete).toHaveBeenCalledWith('account-a', 'account-a/file.jpg');
  });

  it('propagates storage failures so cleanup can be retried', async () => {
    const { app, repository, storage } = setup();
    const marked = { ...metadata(), documentDeletedAt: '2026-10-28T13:00:00.000Z' };
    repository.markReceiptDocumentDeleted.mockResolvedValue(marked);
    storage.delete.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expect(app.deleteImage(context, 'receipt-1')).rejects.toThrow('permission denied');
    await expect(app.deleteImage(context, 'receipt-1')).resolves.toEqual(marked);

    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it('does not delete storage for an unknown account-scoped receipt', async () => {
    const { app, repository, storage } = setup();
    repository.markReceiptDocumentDeleted.mockResolvedValue(null);

    await expect(app.deleteImage(context, 'missing-receipt')).resolves.toBeNull();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('does not return another account receipt content', async () => {
    const { app, repository, storage } = setup();
    repository.getReceipt.mockResolvedValue(null);
    await expect(app.getImage({ accountId: 'account-b', actorId: 'account-b' }, 'receipt-1')).resolves.toBeNull();
    expect(repository.getReceipt).toHaveBeenCalledWith('account-b', 'receipt-1');
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('requires an explicit total-only choice when a reviewed receipt has no line items', async () => {
    const { app, repository } = setup();
    await expect(app.reviewDraft(context, 'draft-1', {
      date: '2026-10-28', amount: '3', currency: 'EUR', merchantName: 'Lidl', category: 'Groceries', categoryId: null,
      description: 'Lidl', items: [], itemizationReviewed: true, totalOnly: false, adjustments: [],
    })).rejects.toThrow(/total-only explicitly/);
    expect(repository.updateDraft).not.toHaveBeenCalled();
  });

  it('returns a server-calculated reconciliation for the user-reviewed total and signed discount', async () => {
    const { app, repository } = setup();
    repository.getDraft.mockResolvedValue({ id: 'draft-1', receipts: [metadata()] } as any);
    const reviewItems = [{ description: 'Basket', productCode: null, quantity: '1', unit: 'basket', unitPrice: '73.10', discount: '0', tax: '0', lineTotal: '73.10', currency: 'EUR', sourceReceiptId: 'receipt-1', normalizedDescription: null, packaging: null, taxIncluded: true, categoryId: null, extractionProvenance: null }];
    repository.updateDraft.mockResolvedValue({
      id: 'draft-1', status: 'needs_review', amount: '70.54', currency: 'EUR', receipts: [{ ...metadata(), reviewedTotal: '70.54', reviewedCurrency: 'EUR', extraction: { ...extraction, total: field('3') } }],
    } as any);
    const result = await app.reviewDraft(context, 'draft-1', {
      date: '2026-10-28', amount: '70.54', currency: 'EUR', merchantName: 'Lidl', category: 'Groceries', categoryId: null,
      description: 'Lidl', items: reviewItems, itemizationReviewed: true, totalOnly: false,
      adjustments: [{ label: 'Discount', amount: '2.56', signedAmount: '-2.56', kind: 'discount', includedInTotal: true, includedInLineTotal: false }],
    });
    expect(result?.reconciliation).toMatchObject({ matched: true, itemTotal: '70.54', total: '70.54', adjustmentTotal: '-2.56', difference: '0' });
    expect(repository.updateDraft).toHaveBeenCalledWith('account-a', 'account-a', 'draft-1', expect.objectContaining({ amount: '70.54' }));
  });

  it('requires explicit acknowledgment of Finance preview findings and records it in the review write', async () => {
    const { app, repository } = setup();
    repository.getDraft.mockResolvedValue({ id: 'draft-1', receipts: [{ ...metadata(), extraction: { ...extraction, ocrEvidence: { provider: 'paddleocr', model: 'pp-ocrv5', lines: [{ id: 0, order: 0, text: 'receipt', confidence: 0.9, box: [0, 0, 10, 10] }] }, documentEntries: [{}] } }] } as any);
    const review = {
      date: '2026-10-28', amount: '3', currency: 'EUR', merchantName: 'Lidl', category: 'Groceries', categoryId: null,
      description: 'Lidl', items: [], itemizationReviewed: true, totalOnly: true, adjustments: [],
    };
    await expect(app.reviewDraft(context, 'draft-1', review)).rejects.toThrow(/acknowledge the receipt findings/i);
    expect(repository.updateDraft).not.toHaveBeenCalled();
    await app.reviewDraft(context, 'draft-1', { ...review, financialFindingsAcknowledged: true });
    expect(repository.updateDraft).toHaveBeenCalledWith('account-a', 'account-a', 'draft-1', expect.objectContaining({ financialFindingsAcknowledged: true }));
  });
});

function previewEntry(kind: string, description: string, amount: string, lineId: number) {
  const f = <T>(value: T | null) => ({ ...field(value), sourceLineIds: value === null ? [] : [lineId] });
  return {
    kind: f(kind), description: f(description), amount: f(amount), signedAmount: f(null), quantity: f(null), unit: f(null), unitPrice: f(null),
    discount: f(null), tax: f(null), taxIncluded: f(null), adjustmentKind: f(null), includedInTotal: f(null),
    includedInLineTotal: f(null), relatedPurchaseIndex: f(null), suggestedCategory: f(null),
  };
}
