import { ReceiptIntelligenceApplication } from './receipt-intelligence.application';
import type { ReceiptExtractionV1 } from '../domain/receipt-extraction.types';

const field = <T>(value: T | null) => ({ value, confidence: value === null ? null : 0.9, uncertainty: null, sourceText: value === null ? null : String(value) });
const extraction: ReceiptExtractionV1 = {
  schemaVersion: 'receipt-extraction-v1', documentType: field('receipt'), merchant: field('Lidl'), date: field('2026-10-28'), time: field(null), currency: field('EUR'),
  subtotal: field('3'), taxTotal: field(null), discountTotal: field(null), depositTotal: field(null), total: field('3'), adjustments: [], sourceText: 'Yogurt 3.00', warnings: [],
  items: [{ originalDescription: field('Yogurt'), normalizedDescription: field('Yogurt'), quantity: field('1'), unit: field('each'), packaging: field(null), unitPrice: field('3'), lineTotal: field('3'), discount: field('0'), tax: field('0'), taxIncluded: field(true), suggestedCategory: field('Groceries') }],
};

describe('receipt intelligence application', () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const context = { accountId: 'account-a', actorId: 'account-a' };
  const metadata = (storageKey = 'account-a/file.jpg', contentHash = 'hash') => ({ id: 'receipt-1', accountId: 'account-a', draftId: 'draft-1', expenseId: null, contentHash, mediaType: 'image/jpeg', byteLength: 4, storageKey, status: 'review_required', extractedTotals: { subtotal: '3', tax: null, discount: null, total: '3', currency: 'EUR' }, parserProvider: 'test', parserModel: 'vision', extraction, createdAt: '2026-10-28T10:00:00.000Z' });

  function setup() {
    const repository = {
      findReceiptByHash: jest.fn().mockResolvedValue(null), createDraft: jest.fn().mockImplementation(async (_account, _actor, proposal) => ({ id: 'draft-1', accountId: 'account-a', status: 'proposed', ...proposal, receipts: [metadata(proposal.receipts[0].storageKey, proposal.receipts[0].contentHash)] })),
      getDraft: jest.fn(), findPossibleReceiptMatches: jest.fn().mockResolvedValue([]), getReceipt: jest.fn().mockResolvedValue(metadata()),
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
    expect(repository).not.toHaveProperty('confirmDraft');
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
