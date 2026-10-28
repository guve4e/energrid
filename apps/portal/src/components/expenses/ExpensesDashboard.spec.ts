import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ExpensesDashboard from './ExpensesDashboard.vue';
import { setAuthenticatedSession } from '../../auth/auth-client';

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

function setup(options: { incomplete?: boolean; records?: unknown[]; byMonth?: Array<{ month: string; total: string; count: number }> } = {}) {
  const { incomplete = false, records = [], byMonth = [
    { month: '2025-01', total: '50.00', count: 2 },
    { month: '2025-02', total: '0', count: 0 },
    { month: '2025-03', total: '15.00', count: 1 },
    { month: '2025-04', total: '18.00', count: 1 },
    { month: '2025-05', total: '21.00', count: 1 },
    { month: '2025-06', total: '22.00', count: 1 },
    { month: '2025-07', total: '23.00', count: 1 },
    { month: '2025-08', total: '24.00', count: 1 },
    { month: '2025-09', total: '25.00', count: 1 },
    { month: '2025-10', total: '26.00', count: 1 },
  ] } = options;
  setAuthenticatedSession({ accessToken: 'finance-token', expiresIn: 900, user: { id: 'account-1', email: 'user@example.test', name: 'User', role: 'viewer' } });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/expenses/import/preview')) return jsonResponse({ records: [{ _id: 'legacy-a', date: '2025-01-03', amount: '5', currency: 'EUR', category: 'Groceries', description: 'Food' }], total: 1, valid: 1, duplicates: 0, errors: [] });
    if (url.endsWith('/expenses/import')) return jsonResponse({ imported: 1, duplicates: 0 });
    if (url.endsWith('/personal-finance/categories')) return jsonResponse({ categories: [{ id: 'category-groceries', name: 'Groceries', status: 'active' }, { id: 'category-fuel', name: 'Fuel', status: 'active' }] });
    if (url.includes('/personal-finance/expenses')) return jsonResponse({ expenses: records });
    if (url === '/personal-finance/summary') return jsonResponse({ total: '407.77997734979664', dailyAverage: null, transactionCount: 1, excludedUnconvertedCount: 0, legacyCoverage: incomplete ? 'leveldb-unavailable' : 'leveldb-available', byCategory: [{ category: 'Historical', total: '1.25', count: 1 }], byMonth });
    if (url.includes('/personal-finance/summary')) {
      const date = new URL(`http://finance.local${url}`).searchParams.get('fromDate');
      if (date === '2026-04-01') return jsonResponse({ total: '0', dailyAverage: '0', transactionCount: 0, excludedUnconvertedCount: 0, legacyCoverage: 'leveldb-available', byCategory: [] });
      return jsonResponse({ total: '407.77997734979664', dailyAverage: '13.15', transactionCount: 1, excludedUnconvertedCount: 0, legacyCoverage: incomplete ? 'leveldb-unavailable' : 'leveldb-available', byCategory: [{ category: 'Groceries', total: '407.77997734979664', count: 1 }] });
    }
    return jsonResponse({});
  }));
  wrapper = mount(ExpensesDashboard, { props: { apiBase: '', accessToken: 'finance-token' } });
  return { calls };
}

describe('Personal Finance V2 Portal cutover', () => {
  it('requires consent, uploads privately, reviews a receipt, and confirms only after an explicit save action', async () => {
    setAuthenticatedSession({ accessToken: 'finance-token', expiresIn: 900, user: { id: 'account-1', email: 'user@example.test', name: 'User', role: 'viewer' } });
    const draft = { id: 'draft-1', status: 'proposed', date: '2026-10-28', amount: '3.00', currency: 'EUR', merchantName: 'Lidl', category: null, description: 'Lidl', items: [{ description: 'Milk', normalizedDescription: 'Milk', quantity: '1', unit: 'each', unitPrice: '3.00', discount: '0', tax: '0', taxIncluded: true, lineTotal: '3.00', currency: 'EUR', categoryId: null, sourceReceiptId: 'receipt-1', packaging: null, extractionProvenance: { provider: 'openai', confidence: 0.99 } }], receipts: [{ id: 'receipt-1', contentHash: 'abc', parserProvider: 'openai', extraction: null }], tags: [] };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const NativeURL = URL;
    class ReceiptURL extends NativeURL { static override createObjectURL = vi.fn(() => 'blob:receipt'); static override revokeObjectURL = vi.fn(); }
    vi.stubGlobal('URL', ReceiptURL);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/receipts/extract')) return jsonResponse({ duplicate: false, draft, possibleMatches: [], reconciliation: { matched: true, itemTotal: '3', total: '3', difference: '0', warnings: [] } });
      if (url.endsWith('/receipts/receipt-1/content')) return { ok: true, status: 200, blob: async () => new Blob(['image']) };
      if (url.endsWith('/drafts/draft-1')) return jsonResponse({ draft: { ...draft, status: 'needs_review' } });
      if (url.endsWith('/drafts/draft-1/confirm')) return jsonResponse({ expense: { id: 'expense-1' } });
      if (url.endsWith('/personal-finance/categories')) return jsonResponse({ categories: [{ id: 'groceries-id', name: 'Groceries', status: 'active' }] });
      if (url.includes('/personal-finance/expenses')) return jsonResponse({ expenses: [] });
      if (url === '/personal-finance/summary') return jsonResponse({ total: '3', transactionCount: 1, excludedUnconvertedCount: 0, byCategory: [] });
      if (url.includes('/personal-finance/summary')) return jsonResponse({ total: '3', transactionCount: 1, excludedUnconvertedCount: 0, byCategory: [] });
      return jsonResponse({});
    }));
    wrapper = mount(ExpensesDashboard, { props: { apiBase: '', accessToken: 'finance-token' } });
    await flushPromises();
    const scan = wrapper!.findAll('button').find((button) => button.text().includes('Scan receipt'))!;
    await scan.trigger('click');
    const fileInput = wrapper!.get('input[accept="image/jpeg,image/png"]');
    expect((fileInput.element as HTMLInputElement).disabled).toBe(true);
    expect(calls.some(({ url }) => url.endsWith('/receipts/extract'))).toBe(false);
    await wrapper!.findAll('label').find((label) => label.text().includes('I consent to cloud processing'))!.get('input').setValue(true);
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'receipt.jpg', { type: 'image/jpeg' });
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: { 0: file, length: 1, item: (index: number) => index === 0 ? file : null } });
    await fileInput.trigger('change');
    await flushPromises();
    expect(calls.some(({ url, init }) => url.endsWith('/receipts/extract') && init?.body instanceof FormData)).toBe(true);
    expect(calls.find(({ url }) => url.endsWith('/receipts/receipt-1/content'))).toBeTruthy();
    expect(calls.some(({ url }) => url.endsWith('/drafts/draft-1/confirm'))).toBe(false);
    expect(wrapper!.text()).toContain('Purchased items (1)');
    expect(wrapper!.text()).toContain('Milk');
    expect(wrapper!.text()).toContain('Items match the receipt total');
    expect((wrapper!.get('details.receipt-advanced').element as HTMLDetailsElement).open).toBe(false);
    await wrapper!.get('input[type="date"]').setValue('2026-10-28');
    await wrapper!.findAll('label').find((label) => label.text().startsWith('Category'))!.get('select').setValue('Groceries');
    const textInputs = wrapper!.findAll('input');
    const amountInput = textInputs.find((input) => input.attributes('placeholder') === 'Enter total')!;
    await amountInput.setValue('3.00');
    const descriptionInput = textInputs.find((input) => input.attributes('placeholder') === 'Optional expense note')!;
    await descriptionInput.setValue('Lidl');
    await wrapper!.findAll('label').find((label) => label.text().includes('Save without item details'))!.get('input').setValue(true);
    const confirm = wrapper!.findAll('button').find((button) => button.text().includes('Save expense'))!;
    await confirm.trigger('click');
    await flushPromises();
    expect(calls.some(({ url, init }) => url.endsWith('/drafts/draft-1') && init?.method === 'PATCH')).toBe(true);
    expect(calls.some(({ url, init }) => url.endsWith('/drafts/draft-1/confirm') && init?.method === 'POST')).toBe(true);
  });

  it('lets the user edit a compact item and preserves its structured extraction data on save', async () => {
    setAuthenticatedSession({ accessToken: 'finance-token', expiresIn: 900, user: { id: 'account-1', email: 'user@example.test', name: 'User', role: 'viewer' } });
    const item = { description: 'Milk', normalizedDescription: 'Milk', quantity: '1', unit: 'each', unitPrice: '3.00', discount: '0', tax: '0', taxIncluded: true, lineTotal: '3.00', currency: 'EUR', categoryId: null, sourceReceiptId: 'receipt-1', packaging: '1 L carton', extractionProvenance: { provider: 'openai', confidence: 0.99 } };
    const draft = { id: 'draft-1', status: 'proposed', date: '2026-10-28', amount: '3.00', currency: 'EUR', merchantName: 'Lidl', category: null, description: 'Lidl', items: [item], receipts: [{ id: 'receipt-1', contentHash: 'abc', parserProvider: 'openai', extraction: null }], tags: [] };
    let reviewed: any;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/receipts/extract')) return jsonResponse({ duplicate: false, draft, possibleMatches: [], reconciliation: { matched: true, itemTotal: '3.00', total: '3.00', difference: '0', warnings: [] } });
      if (url.endsWith('/receipts/receipt-1/content')) return { ok: true, status: 200, blob: async () => new Blob(['image']) };
      if (url.endsWith('/drafts/draft-1') && init?.method === 'PATCH') { reviewed = JSON.parse(String(init.body)); return jsonResponse({ draft }); }
      if (url.endsWith('/drafts/draft-1/confirm')) return jsonResponse({ expense: { id: 'expense-1' } });
      if (url.endsWith('/personal-finance/categories')) return jsonResponse({ categories: [{ id: 'groceries-id', name: 'Groceries', status: 'active' }] });
      if (url.includes('/personal-finance/expenses')) return jsonResponse({ expenses: [] });
      if (url.includes('/personal-finance/summary')) return jsonResponse({ total: '3.00', transactionCount: 1, excludedUnconvertedCount: 0, byCategory: [] });
      return jsonResponse({});
    }));
    wrapper = mount(ExpensesDashboard, { props: { apiBase: '', accessToken: 'finance-token' } });
    await flushPromises();
    await wrapper!.findAll('button').find((button) => button.text().includes('Scan receipt'))!.trigger('click');
    await wrapper!.findAll('label').find((label) => label.text().includes('I consent to cloud processing'))!.get('input').setValue(true);
    const fileInput = wrapper!.get('input[accept="image/jpeg,image/png"]');
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'receipt.jpg', { type: 'image/jpeg' });
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: { 0: file, length: 1, item: (index: number) => index === 0 ? file : null } });
    await fileInput.trigger('change');
    await flushPromises();
    expect(wrapper!.find('details.receipt-item').exists()).toBe(true);
    const itemDetails = wrapper!.get('details.receipt-item');
    (itemDetails.element as HTMLDetailsElement).open = true;
    await itemDetails.trigger('toggle');
    const itemDescription = wrapper!.findAll('input').find((input) => input.element.value === 'Milk')!;
    await itemDescription.setValue('Oat milk');
    await wrapper!.findAll('label').find((label) => label.text().startsWith('Category'))!.get('select').setValue('Groceries');
    expect(wrapper!.text()).toContain('Items match the receipt total');
    await wrapper!.findAll('button').find((button) => button.text().includes('Save expense'))!.trigger('click');
    await flushPromises();
    expect(reviewed.items[0]).toMatchObject({ description: 'Oat milk', normalizedDescription: 'Milk', quantity: '1', unit: 'each', unitPrice: '3.00', discount: '0', tax: '0', lineTotal: '3.00', packaging: '1 L carton', extractionProvenance: { provider: 'openai', confidence: 0.99 } });
  });

  it('loads backend summaries and searches through V2 routes', async () => {
    const { calls } = setup();
    await flushPromises();
    expect(calls.some(({ url }) => url.startsWith('/personal-finance/expenses?limit=1000') && !url.includes('fromDate='))).toBe(true);
    expect(calls.some(({ url }) => url.startsWith('/personal-finance/summary?'))).toBe(true);
    expect(calls.some(({ url }) => url === '/personal-finance/summary')).toBe(true);
    expect(wrapper!.text()).toContain('407');
    expect(wrapper!.text()).toContain('Daily pace');
    expect(wrapper!.text()).toContain('All history');
    expect(wrapper!.get('select[aria-label="Transaction date range"]').element).toHaveProperty('value', 'all');
    expect(wrapper!.get('select[aria-label="Filter expenses by category"]').text()).toContain('Historical');
    expect(wrapper!.text()).toContain('Groceries');
    await wrapper!.get('input[type="month"]').setValue('2025-01');
    await wrapper!.get('select[aria-label="Transaction date range"]').setValue('month');
    await flushPromises();
    expect(wrapper!.text()).toContain('€13.15');
    expect(wrapper!.text()).toContain('Year total');
    const monthQueries = calls.filter(({ url }) => url.includes('/personal-finance/summary?fromDate='));
    expect(monthQueries.some(({ url }) => url.includes('fromDate=2025-01-01'))).toBe(true);
    expect(calls.some(({ url }) => url.includes('/personal-finance/expenses?') && url.includes('fromDate=2025-01-01') && url.includes('toDate=2025-01-31'))).toBe(true);
    await wrapper!.get('input[aria-label="Search expenses"]').setValue('lidl');
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushPromises();
    expect(calls.some(({ url }) => url.includes('text=lidl'))).toBe(true);
    await wrapper!.get('select[aria-label="Filter expenses by category"]').setValue('Fuel');
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushPromises();
    expect(calls.some(({ url }) => url.includes('category=Fuel'))).toBe(true);
    expect(calls.every(({ url }) => !url.includes('/personal-expenses'))).toBe(true);
  });

  it('paginates the complete transaction result without dropping records', async () => {
    const records = Array.from({ length: 120 }, (_, index) => ({
      id: `expense-${index}`,
      date: `2026-10-${String((index % 28) + 1).padStart(2, '0')}`,
      amount: '1.00', currency: 'EUR', amountEur: '1.00', category: 'Groceries',
      description: `Receipt ${index}`, tags: [],
    }));
    setup({ records });
    await flushPromises();
    expect(wrapper!.findAll('.expense-table tbody tr')).toHaveLength(50);
    expect(wrapper!.get('[aria-label="Transaction pages"]').text()).toContain('Showing 1–50 of 120');
    expect(wrapper!.get('[aria-label="Transaction pages"]').text()).toContain('Page 1 of 3');
    await wrapper!.get('[aria-label="Transaction pages"] button:last-child').trigger('click');
    expect(wrapper!.findAll('.expense-table tbody tr')).toHaveLength(50);
    expect(wrapper!.get('[aria-label="Transaction pages"]').text()).toContain('Showing 51–100 of 120');
    await wrapper!.get('[aria-label="Transaction pages"] button:last-child').trigger('click');
    expect(wrapper!.findAll('.expense-table tbody tr')).toHaveLength(20);
    expect(wrapper!.get('[aria-label="Transaction pages"]').text()).toContain('Showing 101–120 of 120');
  });

  it('warns when totals omit unavailable LevelDB history', async () => {
    setup({ incomplete: true });
    await flushPromises();
    expect(wrapper!.get('[role="status"]').text()).toContain('LevelDB expenses could not be loaded');
  });

  it('keeps the dashboard free of capture and historical-import promotions', async () => {
    const { calls } = setup();
    await flushPromises();
    expect(wrapper!.text()).not.toContain('Tell Energrid what you spent');
    expect(wrapper!.text()).not.toContain('Import old data');
    expect(wrapper!.text()).not.toContain('Bring in your history');
    expect(calls.every(({ url }) => !url.includes('/expenses/import'))).toBe(true);
    expect(wrapper!.text()).toContain('Manage categories');
    expect(wrapper!.text()).toContain('Add expense');
  });

  it('uses configured category choices and only captures liters for Fuel expenses', async () => {
    const { calls } = setup();
    await flushPromises();
    const addButton = wrapper!.findAll('button').find((button) => button.text().includes('Add expense'))!;
    await addButton.trigger('click');
    const category = wrapper!.get('select[aria-label="Expense category"]');
    expect(category.findAll('option').map((option) => option.text())).toEqual(['Choose a category', 'Fuel', 'Groceries']);
    expect(wrapper!.text()).not.toContain('Fuel volume');

    await category.setValue('Fuel');
    expect(wrapper!.text()).toContain('Fuel volume');
    await wrapper!.get('input[placeholder="Optional"]').setValue('42.5');

    await wrapper!.get('input[type="number"]').setValue('40');
    await wrapper!.get('input[placeholder="Merchant or what you bought"]').setValue('Fuel stop');
    await wrapper!.get('.expense-modal form').trigger('submit');
    await flushPromises();
    const fuelCall = calls.find(({ url, init }) => url === '/personal-finance/expenses' && init?.method === 'POST');
    expect(JSON.parse(String(fuelCall?.init?.body))).toMatchObject({ category: 'Fuel', categoryId: 'category-fuel', liters: 42.5 });

    const secondAddButton = wrapper!.findAll('button').find((button) => button.text().includes('Add expense'))!;
    await secondAddButton.trigger('click');
    const secondCategory = wrapper!.get('select[aria-label="Expense category"]');
    await secondCategory.setValue('Fuel');
    await wrapper!.get('input[placeholder="Optional"]').setValue('42.5');
    await secondCategory.setValue('Groceries');
    expect(wrapper!.text()).not.toContain('Fuel volume');

    await wrapper!.get('input[type="number"]').setValue('40');
    await wrapper!.get('input[placeholder="Merchant or what you bought"]').setValue('Weekly shop');
    await wrapper!.get('.expense-modal form').trigger('submit');
    await flushPromises();
    const createCalls = calls.filter(({ url, init }) => url === '/personal-finance/expenses' && init?.method === 'POST');
    expect(JSON.parse(String(createCalls[1]?.init?.body))).toMatchObject({ category: 'Groceries', categoryId: 'category-groceries', liters: null });
  });

  it('uses month, calendar-year, and all-history scopes for transactions and summaries', async () => {
    const { calls } = setup();
    await flushPromises();
    const scope = wrapper!.get('select[aria-label="Transaction date range"]');
    expect(scope.text()).toContain('Selected year');
    expect(scope.element).toHaveProperty('value', 'all');
    expect(wrapper!.text()).toContain('Category totals · All history · EUR');

    await scope.setValue('month');
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushPromises();
    expect(wrapper!.text()).toContain('Category totals · October 2026 · EUR');
    expect(calls.some(({ url }) => url.includes('/personal-finance/expenses?') && url.includes('fromDate=2026-10-01') && url.includes('toDate=2026-10-31'))).toBe(true);

    await scope.setValue('year');
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushPromises();
    expect(calls.some(({ url }) => url.includes('/personal-finance/expenses?') && url.includes('fromDate=2026-01-01') && url.includes('toDate=2026-12-31'))).toBe(true);
    expect(calls.some(({ url }) => url.includes('/personal-finance/summary?') && url.includes('fromDate=2026-01-01') && url.includes('toDate=2026-12-31'))).toBe(true);
    expect(wrapper!.text()).toContain('Category totals · 2026 · EUR');
    expect(wrapper!.text()).toContain('2026 calendar year');

    await scope.setValue('all');
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushPromises();
    expect(calls.some(({ url }) => url.includes('/personal-finance/expenses?limit=1000') && !url.includes('fromDate=') && !url.includes('toDate='))).toBe(true);
    expect(wrapper!.text()).toContain('Category totals · All history · EUR');
    expect(wrapper!.text()).toContain('All recorded dates');
    await wrapper!.get('input[aria-label="Search expenses"]').setValue('lidl');
    await wrapper!.get('select[aria-label="Filter expenses by category"]').setValue('Fuel');
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushPromises();
    expect(calls.some(({ url }) => url.includes('text=lidl') && url.includes('category=Fuel') && !url.includes('fromDate='))).toBe(true);
  });

  it('shows only months with recorded spending and fills every activity bar in the same blue', async () => {
    setup();
    await flushPromises();
    const chart = wrapper!.get('[aria-label^="Monthly spending for 8 recent months"]');
    expect(chart.findAll('button')).toHaveLength(8);
    expect(chart.text()).not.toContain('Feb ’25');
    expect(chart.text()).toContain('Apr ’25');
    expect(chart.text()).toContain('Oct ’25');
    expect(wrapper!.get('.expense-chart-total').text()).toContain('October 2025');
    expect(wrapper!.get('.expense-chart-total').text()).toContain('€26.00');
    expect(chart.findAll('.expense-chart-column.selected')).toHaveLength(0);
    expect(chart.findAll('.expense-chart-line')).toHaveLength(0);
    for (const button of chart.findAll('button')) {
      const bar = button.get('.expense-chart-bar');
      expect(bar.attributes('style')).toContain('height:');
      expect(bar.attributes('style')).toContain('width: 100%');
      expect(Number.parseFloat(bar.element.getAttribute('style')!.match(/height:\s*([\d.]+)%/)?.[1] ?? '0')).toBeGreaterThan(0);
    }
    const monthButton = chart.findAll('button').find((button) => button.attributes('aria-label')?.includes('April 2025'))!;
    expect(monthButton.attributes('aria-label')).toContain('€18.00');
    expect(monthButton.attributes('aria-label')).toContain('1 expenses');
    await monthButton.trigger('click');
    await flushPromises();
    expect(wrapper!.get('input[type="month"]').element).toHaveProperty('value', '2025-04');
    expect(wrapper!.get('select[aria-label="Transaction date range"]').element).toHaveProperty('value', 'month');
    expect(chart.findAll('.expense-chart-column.selected')).toHaveLength(1);
    expect(wrapper!.text()).toContain('Category totals · April 2025 · EUR');
    expect(wrapper!.get('.expense-chart-total').text()).toContain('April 2025');
    expect(wrapper!.get('.expense-chart-total').text()).toContain('€18.00');
  });

  it('shows an explicit empty state instead of bars when no month has expense records', async () => {
    setup({ byMonth: [{ month: '2025-01', total: '0', count: 0 }] });
    await flushPromises();
    expect(wrapper!.get('.expense-chart-empty').text()).toBe('No recorded spending yet.');
    expect(wrapper!.findAll('.expense-chart-column')).toHaveLength(0);
  });

  it('turns successful non-JSON API responses into a readable error state', async () => {
    setAuthenticatedSession({ accessToken: 'finance-token', expiresIn: 900, user: { id: 'account-1', email: 'user@example.test', name: 'User', role: 'viewer' } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html>proxy error</html>' })));
    wrapper = mount(ExpensesDashboard, { props: { apiBase: '', accessToken: 'finance-token' } });
    await flushPromises();
    expect(wrapper!.get('[role="alert"]').text()).toContain('unreadable response (200)');
  });
});
