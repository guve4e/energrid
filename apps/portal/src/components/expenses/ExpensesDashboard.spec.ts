import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ExpensesDashboard from './ExpensesDashboard.vue';
import { setAuthenticatedSession } from '../../auth/auth-client';

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

function setup(options: { incomplete?: boolean; records?: unknown[]; unavailableMonth?: string } = {}) {
  const { incomplete = false, records = [], unavailableMonth } = options;
  setAuthenticatedSession({ accessToken: 'finance-token', expiresIn: 900, user: { id: 'account-1', email: 'user@example.test', name: 'User', role: 'viewer' } });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/expenses/import/preview')) return jsonResponse({ records: [{ _id: 'legacy-a', date: '2025-01-03', amount: '5', currency: 'EUR', category: 'Groceries', description: 'Food' }], total: 1, valid: 1, duplicates: 0, errors: [] });
    if (url.endsWith('/expenses/import')) return jsonResponse({ imported: 1, duplicates: 0 });
    if (url.endsWith('/personal-finance/categories')) return jsonResponse({ categories: [{ id: 'category-groceries', name: 'Groceries', status: 'active' }, { id: 'category-fuel', name: 'Fuel', status: 'active' }] });
    if (url.includes('/personal-finance/expenses')) return jsonResponse({ expenses: records });
    if (unavailableMonth && url.includes(`fromDate=${unavailableMonth}-01`)) return jsonResponse({ message: 'Temporary summary failure' }, false, 503);
    if (url === '/personal-finance/summary') return jsonResponse({ total: '407.77997734979664', dailyAverage: null, transactionCount: 1, excludedUnconvertedCount: 0, legacyCoverage: incomplete ? 'leveldb-unavailable' : 'leveldb-available', byCategory: [{ category: 'Historical', total: '1.25', count: 1 }] });
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
  it('loads backend summaries and searches through V2 routes', async () => {
    const { calls } = setup();
    await flushPromises();
    expect(calls.some(({ url }) => url.startsWith('/personal-finance/expenses?limit=1000&fromDate='))).toBe(true);
    expect(calls.some(({ url }) => url.startsWith('/personal-finance/summary?'))).toBe(true);
    expect(calls.some(({ url }) => url === '/personal-finance/summary')).toBe(true);
    expect(wrapper!.text()).toContain('407');
    expect(wrapper!.text()).toContain('Daily pace');
    expect(wrapper!.text()).toContain('€13.15');
    expect(wrapper!.text()).toContain('All history');
    expect(wrapper!.get('select[aria-label="Filter expenses by category"]').text()).toContain('Historical');
    expect(wrapper!.text()).toContain('Groceries');
    await wrapper!.get('input[type="month"]').setValue('2025-01');
    await flushPromises();
    expect(wrapper!.text()).toContain('Year total');
    const monthQueries = calls.filter(({ url }) => url.includes('/personal-finance/summary?fromDate='));
    for (const key of ['2024-06', '2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01']) {
      expect(monthQueries.some(({ url }) => url.includes(`fromDate=${key}-01`))).toBe(true);
    }
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

  it('uses the selected month for list filters and allows an explicit all-history scope', async () => {
    const { calls } = setup();
    await flushPromises();
    const scope = wrapper!.get('select[aria-label="Transaction date range"]');
    await scope.setValue('all');
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushPromises();
    expect(calls.some(({ url }) => url.includes('/personal-finance/expenses?limit=1000') && !url.includes('fromDate=') && !url.includes('toDate='))).toBe(true);
    await wrapper!.get('input[aria-label="Search expenses"]').setValue('lidl');
    await wrapper!.get('select[aria-label="Filter expenses by category"]').setValue('Fuel');
    await new Promise((resolve) => setTimeout(resolve, 280));
    await flushPromises();
    expect(calls.some(({ url }) => url.includes('text=lidl') && url.includes('category=Fuel') && !url.includes('fromDate='))).toBe(true);
  });

  it('distinguishes true zero from unavailable monthly data in an eight-month chart', async () => {
    setup({ unavailableMonth: '2026-05' });
    await flushPromises();
    const chart = wrapper!.get('[aria-label^="Monthly spending for eight months"]');
    expect(chart.findAll('button')).toHaveLength(8);
    const zeroMonth = chart.findAll('button').find((button) => button.attributes('aria-label')?.includes('April 2026'))!;
    expect(zeroMonth.attributes('aria-label')).toContain('€0.00');
    expect(zeroMonth.attributes('aria-label')).toContain('0 expenses');
    const unavailableMonth = chart.findAll('button').find((button) => button.attributes('aria-label')?.includes('May 2026'))!;
    expect(unavailableMonth.attributes('aria-label')).toContain('unavailable');
    await zeroMonth.trigger('click');
    await flushPromises();
    expect(wrapper!.get('input[type="month"]').element).toHaveProperty('value', '2026-04');
  });

  it('turns successful non-JSON API responses into a readable error state', async () => {
    setAuthenticatedSession({ accessToken: 'finance-token', expiresIn: 900, user: { id: 'account-1', email: 'user@example.test', name: 'User', role: 'viewer' } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html>proxy error</html>' })));
    wrapper = mount(ExpensesDashboard, { props: { apiBase: '', accessToken: 'finance-token' } });
    await flushPromises();
    expect(wrapper!.get('[role="alert"]').text()).toContain('unreadable response (200)');
  });
});
