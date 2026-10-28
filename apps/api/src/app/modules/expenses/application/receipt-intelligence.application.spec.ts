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
    const repository = {
      findReceiptByHash: jest.fn().mockResolvedValue(null), createDraft: jest.fn().mockImplementation(async (_account, _actor, proposal) => ({ id: 'draft-1', accountId: 'account-a', status: 'proposed', ...proposal, receipts: [metadata(proposal.receipts[0].storageKey, proposal.receipts[0].contentHash, proposal.receipts[0].extraction)] })),
      getDraft: jest.fn(), findPossibleReceiptMatches: jest.fn().mockResolvedValue([]), getReceipt: jest.fn().mockResolvedValue(metadata()),
      replaceReceiptExtraction: jest.fn(),
      updateDraft: jest.fn(), attachReceiptToExpense: jest.fn(), reopenRejectedReceiptDraft: jest.fn(),
    } as any;
    const understanding = { extract: jest.fn().mockResolvedValue({ extraction, provider: 'test', model: 'vision' }) };
    const storage = { put: jest.fn().mockResolvedValue('account-a/file.jpg'), get: jest.fn().mockResolvedValue(bytes), delete: jest.fn().mockResolvedValue(undefined) };
    return { app: new ReceiptIntelligenceApplication(repository, understanding, storage), repository, understanding, storage };
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
    expect(understanding.extract).toHaveBeenCalledWith({ bytes, mediaType: 'image/jpeg' }, { cloudDataConsent: true });
    expect(storage.put).toHaveBeenCalledWith('account-a', 'image/jpeg', bytes);
    expect(repository.createDraft).toHaveBeenCalledWith('account-a', 'account-a', expect.objectContaining({ sourceKind: 'receipt', amount: '3', currency: 'EUR' }));
    expect(result).toMatchObject({ duplicate: false, draft: { id: 'draft-1', status: 'proposed' } });
    expect(result.extractionDiagnostics).toMatchObject({ responseStatus: 'completed', modelItemCount: 1, validatedItemCount: 1, persistedExtractionItemCount: 1, completeDraftItemCount: 1, incompleteExtractionItemCount: 0, completeButUnmappedItemCount: 0 });
    expect(repository.createDraft.mock.calls[0][2].category).toBeNull();
    expect(repository).not.toHaveProperty('confirmDraft');
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
    expect(understanding.extract).toHaveBeenCalledWith({ bytes, mediaType: 'image/jpeg' }, { cloudDataConsent: true });
    expect(repository.replaceReceiptExtraction).toHaveBeenCalledWith('account-a', 'account-a', 'receipt-1', expect.objectContaining({ extraction, amount: '3' }));
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

  it('cleans up the private image if transactional draft persistence fails', async () => {
    const { app, repository, storage } = setup();
    repository.createDraft.mockRejectedValue(new Error('database unavailable'));
    await expect(app.extract(context, bytes, 'image/jpeg', true)).rejects.toThrow('database unavailable');
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('account-a', 'account-a/file.jpg');
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
});
