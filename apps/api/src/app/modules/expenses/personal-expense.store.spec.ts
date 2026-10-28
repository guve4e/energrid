import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalExpenseStore } from './personal-expense.store';

describe('legacy LevelDB expense preservation', () => {
  it('keeps existing account-scoped records readable after a store restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'energrid-expense-restart-'));
    let store = new PersonalExpenseStore(directory);
    try {
      const original = await store.save('account-1', {
        date: '2025-01-03', amount: 135.6, currency: 'BGN', amountEur: 69.33117909020723,
        fxRate: 1.95583, category: 'Fuel', description: 'Nissan', tags: ['petrol'], liters: 53.59,
        legacyRecordId: '67d3da2c28b8234d368fe844',
      });
      await store.onModuleDestroy();
      store = new PersonalExpenseStore(directory);
      await expect(store.get('account-1', original.id)).resolves.toMatchObject({ legacyRecordId: '67d3da2c28b8234d368fe844', amount: 135.6, currency: 'BGN' });
      await expect(store.get('another-account', original.id)).resolves.toBeNull();
    } finally {
      await store.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
