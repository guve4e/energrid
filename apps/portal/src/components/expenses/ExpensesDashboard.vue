<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { authFetch } from '../../auth/auth-client';

type Expense = {
  id: string;
  date: string;
  amount: string;
  currency: string;
  amountEur: string | null;
  fx?: { rate: string } | null;
  category: string;
  categoryId?: string | null;
  description: string;
  tags: string[];
  liters?: string | null;
  legacyRecordId?: string;
  legacyReadOnly?: boolean;
};
type SpendingSummaryView = {
  total: string;
  dailyAverage: string | null;
  transactionCount: number;
  excludedUnconvertedCount: number;
  legacyCoverage: string;
  byCategory: Array<{ category: string; total: string; count: number }>;
  byMonth: Array<{ month: string; total: string; count: number }>;
};
type FinanceCategory = { id: string; name: string; description: string | null; parentId: string | null; status: 'active' | 'archived' };
const props = defineProps<{ apiBase: string; accessToken: string }>();
const expenses = ref<Expense[]>([]);
const emptySummary = (): SpendingSummaryView => ({ total: '0', dailyAverage: null, transactionCount: 0, excludedUnconvertedCount: 0, legacyCoverage: 'leveldb-available', byCategory: [], byMonth: [] });
const summary = ref<SpendingSummaryView>(emptySummary());
const yearSummary = ref<SpendingSummaryView>(emptySummary());
const allHistorySummary = ref<SpendingSummaryView>(emptySummary());
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const addOpen = ref(false);
const editingId = ref<string | null>(null);
const month = ref(localMonth());
const transactionScope = ref<'month' | 'year' | 'all'>('all');
const search = ref('');
const categoryFilter = ref('');
const transactionPage = ref(1);
const transactionPageSize = 50;
const categories = ref<FinanceCategory[]>([]);
const categoriesOpen = ref(false);
const categoryName = ref('');
const categoryDescription = ref('');
const categoryEditId = ref<string | null>(null);
const categoryEditName = ref('');
const originalCategory = ref<string | null>(null);
const form = reactive({
  date: localDate(),
  amount: '',
  currency: 'EUR',
  fxRate: '',
  category: '',
  categoryId: null as string | null,
  description: '',
  tags: '',
  liters: '',
});

const categoryOptions = computed(() => [...new Set([...categories.value.map((item) => item.name), ...summary.value.byCategory.map((item) => item.category), ...allHistorySummary.value.byCategory.map((item) => item.category)])].sort((a, b) => a.localeCompare(b)));
const expenseCategoryOptions = computed(() => {
  const names = categories.value.filter((item) => item.status === 'active').map((item) => item.name);
  if (editingId.value && form.category.trim() && !names.some((name) => name.toLocaleLowerCase() === form.category.trim().toLocaleLowerCase())) {
    names.push(form.category.trim());
  }
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
});
const selectedCategoryIsFuel = computed(() => form.category.trim().toLocaleLowerCase() === 'fuel');
const displaySummary = computed(() => transactionScope.value === 'all'
  ? allHistorySummary.value
  : transactionScope.value === 'year'
    ? yearSummary.value
    : summary.value);
const displayScopeLabel = computed(() => transactionScope.value === 'all'
  ? 'All history'
  : transactionScope.value === 'year'
    ? month.value.slice(0, 4)
    : selectedMonthLabel.value);
const displaySummaryTitle = computed(() => transactionScope.value === 'all'
  ? 'All history'
  : transactionScope.value === 'year'
    ? `${month.value.slice(0, 4)} total`
    : 'This month');
const dailyPaceLabel = computed(() => transactionScope.value === 'month'
  ? 'Average per day this month'
  : transactionScope.value === 'year'
    ? `Average per day in ${month.value.slice(0, 4)}`
    : 'Average per day over all history');
const unconvertedCount = computed(() => displaySummary.value.excludedUnconvertedCount);
const yearTotal = computed(() => Number(yearSummary.value.total));
const allHistoryTotal = computed(() => Number(allHistorySummary.value.total));
const transactionPageCount = computed(() => Math.max(1, Math.ceil(expenses.value.length / transactionPageSize)));
const selectedMonthLabel = computed(() => new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month.value}-15T00:00:00Z`)));
const selectedDateRangeLabel = computed(() => {
  if (transactionScope.value === 'all') return 'All recorded dates';
  if (transactionScope.value === 'year') return `${month.value.slice(0, 4)} calendar year`;
  const range = monthRange(month.value);
  return `${humanDate(range.fromDate)} – ${humanDate(range.toDate)}`;
});
const dailyAverage = computed(() => displaySummary.value.dailyAverage);
const categoryTotals = computed(() => {
  return displaySummary.value.byCategory.map((item) => ({ name: item.category, total: Number(item.total) }));
});
const maxCategoryTotal = computed(() =>
  Math.max(1, ...categoryTotals.value.map((item) => item.total)),
);
const chartMonths = computed(() => {
  return allHistorySummary.value.byMonth
    .filter((item) => item.count > 0)
    .slice(-8)
    .map((summary) => {
      const [year, monthNumber] = summary.month.split('-').map(Number);
      const date = new Date(Date.UTC(year, monthNumber - 1, 1));
      return {
        key: summary.month,
        summary: { total: summary.total, transactionCount: summary.count },
        total: Number(summary.total),
        monthLabel: new Intl.DateTimeFormat(undefined, {
          month: 'short',
          timeZone: 'UTC',
        }).format(date),
        yearLabel: String(date.getUTCFullYear()).slice(-2),
        fullLabel: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date),
      };
    });
});
const maxMonthTotal = computed(() =>
  Math.max(1, ...chartMonths.value.map((item) => item.total)),
);
const chartFocusMonth = computed(() =>
  chartMonths.value.find((item) => item.key === month.value) ?? chartMonths.value.at(-1),
);
const filteredExpenses = computed(() => expenses.value.slice((transactionPage.value - 1) * transactionPageSize, transactionPage.value * transactionPageSize));
const formatEur = (value: number | string) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(Number(value));
const formatNative = (item: Expense) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: item.currency,
    maximumFractionDigits: 2,
  }).format(Number(item.amount));
const humanDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
const euroPercent = (value: number) =>
  `${Math.max(3, Math.round((value / maxCategoryTotal.value) * 100))}%`;

watch([month, transactionScope], () => {
  transactionPage.value = 1;
  void load();
});
watch(() => form.category, () => {
  if (!selectedCategoryIsFuel.value) form.liters = '';
});
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch([search, categoryFilter], () => { transactionPage.value = 1; clearTimeout(searchTimer); searchTimer = setTimeout(loadExpenses, 250); });

function setRequestError(cause: unknown) {
  error.value = cause instanceof Error ? cause.message : 'Your expenses could not be loaded.';
}

async function api(path: string, init?: RequestInit) {
  const response = await authFetch(`${props.apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${props.accessToken}`,
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { /* handled below */ } }
  if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : `The request failed (${response.status}). Please try again.`);
  if (!text) return null;
  if (body === null) throw new Error(`The server returned an unreadable response (${response.status}). Please retry.`);
  return body;
}

function monthRange(value: string) { const [y, m] = value.split('-').map(Number); return { fromDate: `${value}-01`, toDate: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }; }
async function refreshSummaries() {
  const monthRangeValue = monthRange(month.value);
  const year = month.value.slice(0, 4);
  const [monthData, yearData, allHistoryData] = await Promise.all([
    api(`/personal-finance/summary?fromDate=${monthRangeValue.fromDate}&toDate=${monthRangeValue.toDate}`),
    api(`/personal-finance/summary?fromDate=${year}-01-01&toDate=${year}-12-31`),
    api('/personal-finance/summary'),
  ]);
  summary.value = monthData;
  yearSummary.value = yearData;
  allHistorySummary.value = allHistoryData;
}

async function loadExpenses() {
  loading.value = true;
  error.value = '';
  try {
    const categoryResult = await api('/personal-finance/categories');
    categories.value = categoryResult.categories || [];
    const query = new URLSearchParams({ limit: '1000' });
    if (transactionScope.value === 'month') {
      const range = monthRange(month.value);
      query.set('fromDate', range.fromDate);
      query.set('toDate', range.toDate);
    } else if (transactionScope.value === 'year') {
      const year = month.value.slice(0, 4);
      query.set('fromDate', `${year}-01-01`);
      query.set('toDate', `${year}-12-31`);
    }
    if (search.value.trim()) query.set('text', search.value.trim());
    if (categoryFilter.value) query.set('category', categoryFilter.value);
    const result = await api(`/personal-finance/expenses?${query.toString()}`);
    expenses.value = result.expenses || [];
    transactionPage.value = Math.min(transactionPage.value, transactionPageCount.value);
  } catch (cause) {
    setRequestError(cause);
  } finally {
    loading.value = false;
  }
}

async function load() {
  await Promise.all([loadExpenses(), refreshSummaries().catch(setRequestError)]);
}

function selectChartMonth(value: string) {
  transactionScope.value = 'month';
  month.value = value;
}

function chartMonthTitle(item: (typeof chartMonths.value)[number]) {
  return `${item.fullLabel}: ${formatEur(item.summary.total)} · ${item.summary.transactionCount} expenses`;
}

async function saveExpense() {
  const amount = Number(form.amount);
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !form.description.trim() ||
    !form.category.trim()
  )
    return;
  busy.value = true;
  error.value = '';
  try {
    const result = await api(
      editingId.value
          ? `/personal-finance/expenses/${encodeURIComponent(editingId.value)}`
        : '/personal-finance/expenses',
      {
        method: editingId.value ? 'PATCH' : 'POST',
        body: JSON.stringify({
          date: form.date,
          amount: form.amount,
          currency: form.currency,
          ...(form.currency !== 'EUR' && form.fxRate
            ? { fxRate: form.fxRate }
            : {}),
          category: form.category.trim(),
          categoryId: resolvedCategoryId(),
          description: form.description.trim(),
          tags: form.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          liters: selectedCategoryIsFuel.value && form.liters ? form.liters : null,
        }),
      },
    );
    await load();
    addOpen.value = false;
    resetForm();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'The expense could not be saved.';
  } finally {
    busy.value = false;
  }
}

function resolvedCategoryId(): string | null {
  const selected = categories.value.find((item) => item.name.toLocaleLowerCase() === form.category.trim().toLocaleLowerCase());
  if (!editingId.value) return selected?.id ?? null;
  if (form.category === originalCategory.value) return form.categoryId;
  return selected?.id ?? null;
}

async function createCategory() {
  if (!categoryName.value.trim()) return;
  busy.value = true;
  try {
    await api('/personal-finance/categories', { method: 'POST', body: JSON.stringify({ name: categoryName.value, description: categoryDescription.value || null }) });
    categoryName.value = '';
    categoryDescription.value = '';
    await load();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Category could not be created.'; }
  finally { busy.value = false; }
}

async function renameCategory(category: FinanceCategory) {
  const name = categoryEditName.value.trim();
  if (!name) return;
  busy.value = true;
  try {
    await api(`/personal-finance/categories/${encodeURIComponent(category.id)}`, { method: 'PATCH', body: JSON.stringify({ name, description: category.description, parentId: category.parentId }) });
    categoryEditId.value = null;
    await load();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Category could not be renamed.'; }
  finally { busy.value = false; }
}

async function archiveCategory(category: FinanceCategory) {
  busy.value = true;
  try {
    await api(`/personal-finance/categories/${encodeURIComponent(category.id)}/archive`, { method: 'POST' });
    await load();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Category could not be archived.'; }
  finally { busy.value = false; }
}

function openAdd() {
  resetForm();
  addOpen.value = true;
}

function openEdit(item: Expense) {
  editingId.value = item.id;
  originalCategory.value = item.category;
  Object.assign(form, {
    date: item.date,
    amount: String(item.amount),
    currency: item.currency,
    fxRate: item.fx?.rate == null ? '' : String(item.fx.rate),
    category: item.category,
    categoryId: item.categoryId ?? null,
    description: item.description,
    tags: item.tags.join(', '),
    liters: item.liters == null ? '' : String(item.liters),
  });
  addOpen.value = true;
}

async function deleteExpense(item: Expense) {
  if (!window.confirm(`Delete “${item.description}”?`)) return;
  try {
    if (item.legacyReadOnly) { error.value = 'Import this legacy entry before editing or deleting it.'; return; }
    await api(`/personal-finance/expenses/${encodeURIComponent(item.id)}`, {
      method: 'DELETE',
    });
    await load();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'The expense could not be deleted.';
  }
}

function resetForm() {
  editingId.value = null;
  originalCategory.value = null;
  Object.assign(form, {
    date: localDate(),
    amount: '',
    currency: 'EUR',
    fxRate: '',
    category: categories.value.find((item) => item.status === 'active')?.name ?? '',
    categoryId: null,
    description: '',
    tags: '',
    liters: '',
  });
}
function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function localMonth() {
  return localDate().slice(0, 7);
}

onMounted(load);
</script>

<template>
  <section class="panel workspace-panel expenses-page" aria-labelledby="expenses-title">
    <header class="expenses-heading page-heading">
      <div>
        <p class="eyebrow">Personal finance</p>
        <h1 id="expenses-title">Your spending, in one place.</h1>
        <p class="expenses-subtitle">
          A clear view of where your money goes, month by month.
        </p>
      </div>
      <div class="expenses-actions">
        <button class="expense-button expense-button--quiet" type="button" @click="categoriesOpen = true">Manage categories</button>
        <button
          class="expense-button expense-button--primary"
          type="button"
          @click="openAdd"
        >
          ＋ Add expense
        </button>
      </div>
    </header>

    <p v-if="error" class="expense-alert" role="alert">{{ error }}</p>
    <p v-if="unconvertedCount" class="expense-conversion-note" role="status">
      {{ unconvertedCount }}
      {{ unconvertedCount === 1 ? 'transaction is' : 'transactions are' }} in a
      currency without a saved EUR conversion, so
      {{ unconvertedCount === 1 ? 'it is' : 'they are' }} not included in EUR
      totals.
    </p>

    <div class="expense-period-row">
      <div>
        <span class="expense-period-label">Reporting month</span
        ><label class="sr-only" for="expense-month">Choose month</label
        ><input
          id="expense-month"
          v-model="month"
          class="expense-month-picker"
          type="month"
        />
      </div>
      <span v-if="loading" class="expense-muted" role="status"
        >Loading your expenses…</span
      >
      <span v-else class="expense-muted"
        >{{ expenses.length.toLocaleString() }} transactions</span
      >
    </div>

    <div v-if="displaySummary.legacyCoverage === 'leveldb-unavailable'" class="expense-legacy-warning" role="status">
      Older LevelDB expenses could not be loaded. These totals may be incomplete; PostgreSQL records remain available.
    </div>

    <div class="expense-metrics">
      <article class="expense-metric expense-metric--featured">
        <span>{{ displaySummaryTitle }}</span><strong>{{ formatEur(displaySummary.total) }}</strong
        ><small>{{ displaySummary.transactionCount }} recorded expenses</small>
        <div class="expense-metric-glow" aria-hidden="true"></div>
      </article>
      <article class="expense-metric">
        <span>Daily pace</span><strong>{{ dailyAverage === null || dailyAverage === undefined ? '—' : formatEur(dailyAverage) }}</strong
        ><small>{{ dailyPaceLabel }}</small>
      </article>
      <article class="expense-metric">
        <span>{{ month.slice(0, 4) === String(new Date().getFullYear()) ? 'Year to date' : 'Year total' }}</span><strong>{{ formatEur(yearTotal) }}</strong
        ><small>{{ month.slice(0, 4) }} · all categories</small>
      </article>
      <article class="expense-metric">
        <span>All history</span><strong>{{ formatEur(allHistoryTotal) }}</strong
        ><small>{{ allHistorySummary.transactionCount }} recorded expenses</small>
      </article>
      <article class="expense-metric">
        <span>Top category</span
        ><strong class="expense-metric-category">{{
          categoryTotals[0]?.name || '—'
        }}</strong
        ><small>{{
          categoryTotals[0]
            ? `${formatEur(categoryTotals[0].total)} · ${displayScopeLabel}`
            : `No expenses · ${displayScopeLabel}`
        }}</small>
      </article>
    </div>

    <div class="expense-dashboard-grid">
      <article class="expense-card expense-trend-card">
        <div class="expense-card-heading">
          <div>
            <h2>Monthly spending</h2>
            <p>Recent months with recorded expenses · EUR</p>
          </div>
          <span class="expense-chart-total">
            <small v-if="chartFocusMonth">{{ chartFocusMonth.fullLabel }}</small>
            {{ formatEur(chartFocusMonth?.summary.total ?? '0') }}
          </span>
        </div>
        <div
          class="expense-chart"
          :style="{ gridTemplateColumns: `repeat(${Math.max(1, chartMonths.length)}, minmax(0, 1fr))` }"
          role="group"
          :aria-label="`Monthly spending for ${chartMonths.length} recent months with recorded expenses`"
        >
          <p v-if="chartMonths.length === 0" class="expense-chart-empty">No recorded spending yet.</p>
          <button
            v-for="item in chartMonths"
            :key="item.key"
            type="button"
            class="expense-chart-column"
            :class="{ selected: transactionScope === 'month' && item.key === month }"
            :aria-pressed="transactionScope === 'month' && item.key === month"
            :aria-label="chartMonthTitle(item)"
            :title="chartMonthTitle(item)"
            @click="selectChartMonth(item.key)"
          >
            <span class="expense-chart-value">{{ formatEur(item.summary.total) }}</span>
            <div class="expense-chart-track">
              <div
                class="expense-chart-bar"
                :style="{
                  height: `${Math.max(2, (item.total / maxMonthTotal) * 100)}%`,
                  width: '100%',
                }"
              ></div>
            </div>
            <span class="expense-chart-label">{{ item.monthLabel }} ’{{ item.yearLabel }}</span>
          </button>
        </div>
        <div class="expense-chart-foot">
          <span><i></i> Monthly total · keyboard or click to select</span>
          <span v-if="chartMonths.length">{{ chartMonths[0].fullLabel }} – {{ chartMonths[chartMonths.length - 1].fullLabel }}</span>
        </div>
      </article>

      <article class="expense-card expense-categories-card">
        <div class="expense-card-heading">
          <div>
            <h2>Where it goes</h2>
            <p>Category totals · {{ displayScopeLabel }} · EUR</p>
          </div>
        </div>
        <div v-if="categoryTotals.length" class="expense-category-list">
          <div
            v-for="item in categoryTotals"
            :key="item.name"
            class="expense-category-row"
          >
            <div class="expense-category-copy">
              <span>{{ item.name }}</span
              ><strong>{{ formatEur(item.total) }}</strong>
            </div>
            <div class="expense-category-rail">
              <span :style="{ width: euroPercent(item.total) }"></span>
            </div>
          </div>
        </div>
        <div v-else class="expense-empty-small">
          <span class="expense-empty-icon">↗</span
          ><strong>No expenses for this period</strong>
          <p>Choose another reporting period or add an expense.</p>
        </div>
      </article>
    </div>

    <article class="expense-card expense-transactions-card">
      <div class="expense-card-heading expense-transactions-heading">
        <div>
          <h2>Transactions</h2>
          <p>{{ selectedDateRangeLabel }}<template v-if="transactionScope === 'month'"> · {{ selectedMonthLabel }}</template> · {{ expenses.length }} matching</p>
        </div>
        <label class="expense-scope-filter">
          <span class="sr-only">Transaction date range</span>
          <select v-model="transactionScope" aria-label="Transaction date range">
            <option value="month">Selected month</option>
            <option value="year">Selected year</option>
            <option value="all">All history</option>
          </select>
        </label>
        <label class="expense-search"
          ><span aria-hidden="true">⌕</span
          ><input
            v-model="search"
            type="search"
            placeholder="Search merchant, category or tag"
            aria-label="Search expenses"
        /></label>
        <label class="expense-category-filter">
          <span class="sr-only">Filter expenses by category</span>
          <select v-model="categoryFilter" aria-label="Filter expenses by category">
            <option value="">All categories</option>
            <option v-for="category in categoryOptions" :key="category" :value="category">{{ category }}</option>
          </select>
        </label>
      </div>
      <div v-if="loading" class="expense-empty-state">
        Loading transaction history…
      </div>
      <div v-else-if="!filteredExpenses.length" class="expense-empty-state">
        <span class="expense-empty-icon">＋</span
        ><strong>No transactions match this view</strong>
        <p>Choose another month, expand to all history, or adjust the filters.</p>
        <div class="expense-empty-actions">
          <button
            class="expense-button expense-button--primary"
            type="button"
            @click="openAdd"
          >
            Add an expense
          </button>
        </div>
      </div>
      <div v-else class="expense-table-wrap">
        <table class="expense-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Category</th>
              <th>Description</th>
              <th>Tags</th>
              <th class="amount-head">Amount</th>
              <th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredExpenses" :key="item.id">
              <td class="expense-date">{{ humanDate(item.date) }}</td>
              <td>
                <span class="expense-category-pill">{{ item.category }}</span>
              </td>
              <td class="expense-description">
                {{ item.description
                }}<small v-if="item.liters">{{ item.liters }} L</small>
              </td>
              <td>
                <div class="expense-tags">
                  <span v-for="tag in item.tags.slice(0, 2)" :key="tag">{{
                    tag
                  }}</span>
                </div>
              </td>
              <td class="amount-cell">
                <strong>{{ formatNative(item) }}</strong
                ><small
                  v-if="item.currency !== 'EUR' && item.amountEur !== null"
                  >≈ {{ formatEur(item.amountEur) }}</small
                >
              </td>
              <td>
                <button
                  class="expense-edit"
                  type="button"
                  :aria-label="`Edit ${item.description}`"
                  :disabled="item.legacyReadOnly"
                  @click="openEdit(item)"
                >
                  ↗
                </button>
                <button
                  class="expense-delete"
                  type="button"
                  :aria-label="`Delete ${item.description}`"
                  :disabled="item.legacyReadOnly"
                  @click="deleteExpense(item)"
                >
                  ×
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="expenses.length > transactionPageSize" class="expense-table-pagination" aria-label="Transaction pages">
          <span>Showing {{ (transactionPage - 1) * transactionPageSize + 1 }}–{{ Math.min(transactionPage * transactionPageSize, expenses.length) }} of {{ expenses.length }}</span>
          <div>
            <button type="button" class="expense-button expense-button--quiet" :disabled="transactionPage === 1" @click="transactionPage--">Previous</button>
            <span>Page {{ transactionPage }} of {{ transactionPageCount }}</span>
            <button type="button" class="expense-button expense-button--quiet" :disabled="transactionPage === transactionPageCount" @click="transactionPage++">Next</button>
          </div>
        </div>
      </div>
    </article>

    <div
      v-if="addOpen"
      class="expense-modal-backdrop"
      @click.self="addOpen = false"
    >
      <section
        class="expense-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-expense-title"
      >
        <div class="expense-modal-heading">
          <div>
            <p class="eyebrow">Quick capture</p>
            <h2 id="add-expense-title">
              {{ editingId ? 'Edit expense' : 'Add an expense' }}
            </h2>
          </div>
          <button
            class="expense-modal-close"
            type="button"
            aria-label="Close"
            @click="addOpen = false"
          >
            ×
          </button>
        </div>
        <form @submit.prevent="saveExpense">
          <div class="expense-form-grid">
            <label>Date<input v-model="form.date" required type="date" /></label
            ><label
              >Amount
              <div class="expense-amount-input">
                <span>{{ form.currency === 'EUR' ? '€' : form.currency }}</span
                ><input
                  v-model="form.amount"
                  required
                  min="0.01"
                  step="0.01"
                  type="number"
                  placeholder="0.00"
                /></div
            ></label>
          </div>
          <div class="expense-form-grid">
            <label
              >Currency<select v-model="form.currency">
                <option>EUR</option>
                <option>USD</option>
                <option v-if="editingId && form.currency === 'BGN'">BGN</option>
              </select></label
            ><label
              >Category<select v-model="form.category" required aria-label="Expense category">
                <option disabled value="">Choose a category</option>
                <option
                  v-for="category in expenseCategoryOptions"
                  :key="category"
                  :value="category"
                  >{{ category }}</option
                >
              </select
            ></label>
          </div>
          <label v-if="form.currency !== 'EUR' && form.currency !== 'BGN'"
            >Exchange rate <span class="expense-optional">units per €1</span
            ><input
              v-model="form.fxRate"
              min="0.000001"
              step="any"
              type="number"
              placeholder="e.g. 1.08"
          /></label>
          <label
            >Description<input
              v-model="form.description"
              required
              maxlength="500"
              placeholder="Merchant or what you bought"
          /></label>
          <label
            >Tags
            <span class="expense-optional">optional · comma separated</span
            ><input v-model="form.tags" placeholder="e.g. weekly shop, Lidl"
          /></label>
          <label v-if="selectedCategoryIsFuel"
            >Fuel volume <span class="expense-optional">optional · liters</span
            ><input
              v-model="form.liters"
              min="0.01"
              step="0.01"
              type="number"
              placeholder="Optional"
          /></label>
          <div class="expense-modal-footer">
            <span>Your original amount and currency are kept.</span
            ><button
              class="expense-button expense-button--primary"
              type="submit"
              :disabled="busy"
            >
              {{
                busy ? 'Saving…' : editingId ? 'Save changes' : 'Save expense'
              }}
            </button>
          </div>
        </form>
      </section>
    </div>

    <div v-if="categoriesOpen" class="expense-modal-backdrop" @click.self="categoriesOpen = false">
      <section class="expense-modal" role="dialog" aria-modal="true" aria-labelledby="expense-categories-title">
        <div class="expense-modal-heading">
          <div><h2 id="expense-categories-title">Spending categories</h2><p class="expense-modal-lead">Rename or archive categories without changing historical free-text records.</p></div>
          <button class="expense-modal-close" type="button" aria-label="Close categories" @click="categoriesOpen = false">×</button>
        </div>
        <form class="expense-category-create" @submit.prevent="createCategory">
          <label>New category<input v-model="categoryName" required maxlength="80" placeholder="e.g. Education" /></label>
          <label>Description <span class="expense-optional">optional</span><input v-model="categoryDescription" maxlength="500" placeholder="What belongs here?" /></label>
          <button class="expense-button expense-button--primary" type="submit" :disabled="busy">Add category</button>
        </form>
        <ul class="expense-category-manage-list">
          <li v-for="category in categories" :key="category.id">
            <template v-if="categoryEditId === category.id">
              <input v-model="categoryEditName" aria-label="Category name" maxlength="80" />
              <button class="expense-button expense-button--quiet" type="button" :disabled="busy" @click="renameCategory(category)">Save name</button>
              <button class="expense-button expense-button--quiet" type="button" @click="categoryEditId = null">Cancel</button>
            </template>
            <template v-else>
              <span>{{ category.name }}</span>
              <button class="expense-button expense-button--quiet" type="button" @click="categoryEditId = category.id; categoryEditName = category.name">Rename</button>
              <button class="expense-button expense-button--quiet" type="button" :disabled="busy" @click="archiveCategory(category)">Archive</button>
            </template>
          </li>
          <li v-if="!categories.length" class="expense-empty-row">No active categories yet.</li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped>
.expenses-page {
  --ink: var(--eg-text);
  --muted: var(--eg-muted);
  --line: var(--eg-border);
  --surface: var(--eg-surface);
  --mint: var(--eg-blue-soft);
  --deep: var(--eg-blue);
  color: var(--ink);
  display: grid;
  gap: 22px;
  padding: 18px;
}
.expenses-heading,
.expenses-actions,
.expense-period-row,
.expense-card-heading,
.expense-modal-heading,
.expense-modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.expenses-heading h1 {
  color: var(--ink);
  font-size: 28px;
  letter-spacing: -0.035em;
  line-height: 1.2;
  margin: 0 0 6px;
}
.expenses-subtitle,
.expense-card-heading p,
.expense-modal-lead {
  color: var(--muted);
  font-size: 13px;
}
.expenses-page .eyebrow {
  color: var(--eg-blue);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.expense-button {
  border: 1px solid transparent;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 750;
  min-height: 42px;
  padding: 0 16px;
  transition:
    transform 0.15s,
    box-shadow 0.15s;
}
.expense-button:hover {
  transform: translateY(-1px);
}
.expense-button--quiet {
  background: #fff;
  border-color: var(--line);
  color: var(--deep);
}
.expense-button--primary {
  background: var(--eg-blue);
  color: #fff;
  box-shadow: 0 9px 20px #2863e61c;
}
.expense-period-row {
  border-top: 1px solid var(--line);
  padding-top: 16px;
}
.expense-period-label {
  color: var(--muted);
  display: block;
  font-size: 11px;
  margin-bottom: 5px;
}
.expense-month-picker {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--deep);
  font-size: 13px;
  padding: 9px 11px;
}
.expense-muted {
  color: #8b9998;
  font-size: 11px;
}
.expense-legacy-warning {
  background: #fff5e6;
  border: 1px solid #ead3a8;
  border-radius: 9px;
  color: #75531c;
  font-size: 12px;
  line-height: 1.45;
  margin-bottom: 12px;
  padding: 10px 13px;
}
.expense-metrics {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
.expense-metric {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 15px;
  display: grid;
  gap: 7px;
  min-height: 128px;
  overflow: hidden;
  padding: 18px;
  position: relative;
}
.expense-metric > span {
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
}
.expense-metric > strong {
  font-size: clamp(22px, 2.2vw, 29px);
  letter-spacing: -0.04em;
  line-height: 1.1;
}
.expense-metric > small {
  color: #879492;
  font-size: 11px;
}
.expense-metric--featured {
  background: linear-gradient(135deg, #1b4fb8, #2863e6);
  border: 0;
  color: #fff;
}
.expense-metric--featured > span,
.expense-metric--featured > small {
  color: #d4e4d6;
}
.expense-metric-glow {
  background: radial-gradient(ellipse, #b7d2ff49, transparent 68%);
  height: 140px;
  position: absolute;
  right: -30px;
  top: -45px;
  width: 190px;
}
.expense-metric-category {
  font-size: 22px !important;
}
.expense-dashboard-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: minmax(0, 1.65fr) minmax(270px, 1fr);
}
.expense-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 15px;
  min-width: 0;
  padding: 20px;
}
.expense-card-heading {
  align-items: flex-start;
  margin-bottom: 16px;
}
.expense-card-heading h2 {
  font-size: 15px;
  letter-spacing: -0.02em;
  margin: 0 0 5px;
}
.expense-card-heading p {
  font-size: 11px;
  margin: 0;
}
.expense-chart-total {
  color: var(--deep);
  font-size: 15px;
  font-weight: 800;
  text-align: right;
}
.expense-chart-total small {
  color: var(--muted);
  display: block;
  font-size: 9px;
  font-weight: 600;
}
.expense-chart {
  align-items: end;
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 12px;
  height: 205px;
  padding-top: 12px;
}
.expense-chart-column {
  align-items: center;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: grid;
  gap: 3px;
  grid-template-rows: 34px 1fr 22px;
  height: 100%;
  justify-items: center;
  min-width: 0;
  padding: 0 2px;
  width: 100%;
}
.expense-chart-column:focus-visible {
  border-radius: 8px;
  outline: 2px solid var(--eg-blue);
  outline-offset: 2px;
}
.expense-chart-value {
  color: var(--muted);
  font-size: 9px;
  line-height: 1.15;
  max-width: 100%;
  overflow-wrap: anywhere;
  text-align: center;
}
.expense-chart-track {
  align-items: end;
  background: var(--line);
  border-radius: 7px 7px 2px 2px;
  display: flex;
  height: 100%;
  overflow: hidden;
  width: min(28px, 80%);
}
.expense-chart-bar {
  background: linear-gradient(180deg, #79a8ff, #2863e6);
  border-radius: 7px 7px 0 0;
  min-height: 2px;
  transition: height 0.25s;
  width: 100%;
}
.expense-chart-column.selected .expense-chart-track {
  background: var(--eg-blue-soft);
}
.expense-chart-column.selected .expense-chart-label {
  color: var(--deep);
  font-weight: 800;
}
.expense-chart-empty {
  align-self: center;
  color: var(--muted);
  grid-column: 1 / -1;
  justify-self: center;
}
.expense-chart-label {
  color: var(--muted);
  font-size: 9px;
  white-space: nowrap;
}
.expense-chart-foot {
  color: #899693;
  display: flex;
  font-size: 10px;
  justify-content: space-between;
  padding-top: 12px;
}
.expense-chart-foot span:first-child {
  align-items: center;
  display: flex;
  gap: 7px;
}
.expense-chart-foot i {
  background: var(--eg-blue);
  border-radius: 50%;
  height: 7px;
  width: 7px;
}
.expense-category-list {
  display: grid;
  gap: 13px;
}
.expense-category-copy {
  align-items: center;
  display: flex;
  font-size: 11px;
  justify-content: space-between;
  margin-bottom: 6px;
}
.expense-category-copy span {
  color: #526260;
  min-width: 0;
  overflow-wrap: anywhere;
}
.expense-category-copy strong {
  color: var(--deep);
  font-size: 11px;
}
.expense-category-rail {
  background: #eff3ef;
  border-radius: 20px;
  height: 5px;
  overflow: hidden;
}
.expense-category-rail span {
  background: var(--eg-blue);
  border-radius: 20px;
  display: block;
  height: 100%;
}
.expense-scope-filter select {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--ink);
  font-size: 11px;
  min-height: 38px;
  padding: 0 10px;
}
.expense-empty-small {
  align-items: center;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 185px;
  text-align: center;
}
.expense-empty-small strong {
  color: var(--deep);
  font-size: 13px;
  margin: 10px 0 5px;
}
.expense-empty-small p {
  font-size: 11px;
  max-width: 230px;
}
.expense-empty-icon {
  align-items: center;
  background: #eef4e6;
  border-radius: 12px;
  color: #668d43;
  display: grid;
  font-size: 20px;
  height: 42px;
  place-items: center;
  width: 42px;
}
.expense-transactions-card {
  padding: 0;
}
.expense-transactions-heading {
  align-items: center;
  border-bottom: 1px solid var(--line);
  margin: 0;
  padding: 18px 20px;
}
.expense-search {
  align-items: center;
  background: #f6f8f5;
  border: 1px solid #edf0ec;
  border-radius: 9px;
  color: #9aa5a2;
  display: flex;
  gap: 8px;
  margin: 0;
  max-width: 310px;
  padding: 0 10px;
  width: 100%;
}
.expense-category-filter select {
  background: #f6f8f5;
  border: 1px solid #edf0ec;
  border-radius: 9px;
  color: var(--ink);
  font-size: 11px;
  min-height: 38px;
  padding: 0 10px;
}
.expense-search span {
  font-size: 19px;
}
.expense-search input {
  background: transparent;
  border: 0;
  color: var(--ink);
  font-size: 11px;
  min-height: 36px;
  outline: none;
  padding: 0;
}
.expense-table-wrap {
  overflow: auto;
}
.expense-table {
  border-collapse: collapse;
  font-size: 11px;
  width: 100%;
}
.expense-table th {
  color: #98a29f;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 12px 18px;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
}
.expense-table td {
  border-top: 1px solid #eff2ef;
  color: #455452;
  padding: 12px 18px;
  vertical-align: middle;
}
.expense-table tbody tr:hover {
  background: #fbfcfa;
}
.expense-table .amount-head,
.expense-table .amount-cell {
  text-align: right;
}
.expense-date {
  color: #85918e !important;
  white-space: nowrap;
}
.expense-category-pill {
  background: var(--eg-blue-soft);
  border-radius: 30px;
  color: var(--eg-blue);
  display: inline-block;
  font-size: 10px;
  padding: 5px 9px;
  white-space: nowrap;
}
.expense-category-create { display: grid; gap: 12px; margin: 18px 0; }
.expense-category-manage-list { list-style: none; margin: 0; padding: 0; max-height: 42vh; overflow: auto; }
.expense-category-manage-list li { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--border-subtle, #333); padding: 9px 0; }
.expense-category-manage-list li > span { flex: 1; }
.expense-category-manage-list input { flex: 1; min-width: 100px; }
.expense-category-manage-list .expense-button { padding: 7px 10px; }
.expense-description {
  color: var(--ink) !important;
  font-weight: 700;
  max-width: 220px;
}
.expense-description small,
.amount-cell small {
  color: #99a39f;
  display: block;
  font-size: 9px;
  font-weight: 500;
  margin-top: 3px;
}
.expense-tags {
  display: flex;
  gap: 4px;
}
.expense-tags span {
  background: #f4f6f4;
  border-radius: 4px;
  color: #8b9692;
  font-size: 9px;
  padding: 4px 6px;
}
.amount-cell strong {
  color: var(--deep);
  white-space: nowrap;
}
.expense-edit,
.expense-delete {
  background: transparent;
  border-radius: 50%;
  color: #8c9b95;
  font-size: 13px;
  min-height: 26px;
  padding: 0;
  width: 26px;
}
.expense-edit:hover {
  background: #edf4e5;
  color: #567b43;
}
.expense-delete {
  color: #a8b0ad;
  font-size: 18px;
}
.expense-delete:hover {
  background: #fbefed;
  color: #bb554d;
}
.expense-empty-state {
  align-items: center;
  color: #778481;
  display: flex;
  flex-direction: column;
  min-height: 210px;
  justify-content: center;
  text-align: center;
}
.expense-empty-state strong {
  color: var(--deep);
  font-size: 14px;
  margin-top: 12px;
}
.expense-empty-state p {
  font-size: 11px;
  margin-top: 5px;
}
.expense-empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 15px;
}
.expense-table-footnote {
  color: #939e9b;
  font-size: 10px;
  padding: 0 18px 15px;
}
.expense-table-pagination {
  align-items: center;
  border-top: 1px solid var(--line);
  color: var(--muted);
  display: flex;
  font-size: 11px;
  justify-content: space-between;
  padding: 12px 16px;
}
.expense-table-pagination > div {
  align-items: center;
  display: flex;
  gap: 10px;
}
.expense-alert,
.expense-success {
  border-radius: 9px;
  font-size: 12px;
  padding: 10px 13px;
}
.expense-conversion-note {
  background: #fff8ed;
  border-radius: 9px;
  color: #8a6428;
  font-size: 11px;
  padding: 10px 13px;
}
.expense-alert {
  background: #fff0ee;
  color: #a63f35;
}
.expense-success {
  background: #edf7e6;
  color: #4e7335;
}
.expense-modal-backdrop {
  align-items: center;
  background: #0b2020a3;
  display: flex;
  inset: 0;
  justify-content: center;
  overflow: auto;
  padding: 20px;
  position: fixed;
  z-index: 100;
}
.expense-modal {
  background: #fff;
  border: 1px solid #e3e9e5;
  border-radius: 17px;
  box-shadow: 0 24px 80px #10232638;
  max-height: calc(100vh - 40px);
  max-width: 560px;
  overflow: auto;
  padding: 24px;
  width: 100%;
}
.expense-import-modal {
  max-width: 610px;
}
.expense-modal-heading {
  align-items: flex-start;
  margin-bottom: 20px;
}
.expense-modal-heading h2 {
  color: var(--deep);
  font-size: 22px;
  letter-spacing: -0.035em;
  margin: 5px 0;
}
.expense-modal-lead {
  line-height: 1.5;
  margin-top: 7px;
  max-width: 450px;
}
.expense-modal-close {
  background: #f4f6f3;
  border-radius: 50%;
  color: #75817c;
  font-size: 22px;
  min-height: 34px;
  padding: 0;
  width: 34px;
}
.expense-modal form {
  display: grid;
  gap: 13px;
}
.expense-modal form label {
  color: #65726f;
  font-size: 11px;
  font-weight: 700;
  margin: 0;
}
.expense-modal form input,
.expense-modal form select {
  background: #f9faf8;
  border: 1px solid #e3e9e5;
  border-radius: 8px;
  color: #233c3a;
  display: block;
  font-size: 12px;
  margin-top: 6px;
  min-height: 40px;
  padding: 0 11px;
  width: 100%;
}
.expense-form-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: 1fr 1fr;
}
.expense-amount-input {
  align-items: center;
  background: #f9faf8;
  border: 1px solid #e3e9e5;
  border-radius: 8px;
  display: flex;
  margin-top: 6px;
  padding-left: 11px;
}
.expense-amount-input span {
  color: #71827b;
  font-size: 12px;
}
.expense-modal form .expense-amount-input input {
  background: transparent;
  border: 0;
  margin: 0;
}
.expense-optional {
  color: #9aa5a1;
  font-weight: 500;
}
.expense-modal-footer {
  border-top: 1px solid var(--line);
  color: #91a09b;
  font-size: 9px;
  margin-top: 20px;
  padding-top: 15px;
}
.expense-dropzone {
  align-items: center;
  border: 1px dashed #b8c7b5;
  border-radius: 12px;
  color: #4b6454;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 135px;
  padding: 18px;
}
.expense-dropzone:hover {
  background: #f7faf3;
  border-color: #72934e;
}
.expense-dropzone input {
  height: 1px;
  opacity: 0;
  position: absolute;
  width: 1px;
}
.expense-upload-symbol {
  align-items: center;
  background: #eaf2dd;
  border-radius: 11px;
  color: #6b8f49;
  display: grid;
  font-size: 22px;
  height: 38px;
  place-items: center;
  width: 38px;
}
.expense-dropzone strong {
  font-size: 12px;
}
.expense-dropzone small,
.expense-import-status {
  color: #98a39f;
  font-size: 10px;
}
.expense-import-status {
  margin-top: 12px;
}
.expense-preview {
  margin-top: 17px;
}
.expense-preview-stats {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(3, 1fr);
}
.expense-preview-stats div {
  background: #f6f8f4;
  border-radius: 9px;
  display: grid;
  gap: 4px;
  padding: 12px;
}
.expense-preview-stats strong {
  color: var(--deep);
  font-size: 19px;
}
.expense-preview-stats span {
  color: #899590;
  font-size: 9px;
}
.expense-preview-examples {
  background: #f5f8f1;
  border-radius: 9px;
  margin-top: 12px;
  padding: 12px;
}
.expense-preview-examples strong,
.expense-import-errors strong {
  color: #466144;
  font-size: 10px;
}
.expense-preview-examples p {
  color: #78877b;
  font-size: 10px;
  line-height: 1.5;
  margin-top: 4px;
}
.expense-import-errors {
  background: #fff8ed;
  border-radius: 9px;
  color: #9a6728;
  font-size: 10px;
  margin-top: 12px;
  padding: 12px;
}
.expense-import-errors ul {
  display: grid;
  gap: 4px;
  margin: 7px 0 0;
  padding-left: 15px;
}
.sr-only {
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
@media (max-width: 900px) {
  .expense-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .expense-dashboard-grid {
    grid-template-columns: 1fr;
  }
  .expense-category-list {
    grid-template-columns: 1fr 1fr;
    column-gap: 18px;
  }
}
@media (max-width: 640px) {
  .expenses-page {
    gap: 15px;
  }
  .expenses-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .expenses-actions {
    width: 100%;
  }
  .expenses-actions .expense-button {
    flex: 1;
  }
  .expense-metrics {
    gap: 8px;
  }
  .expense-metric {
    min-height: 110px;
    padding: 13px;
  }
  .expense-metric > strong {
    font-size: 22px;
  }
  .expense-metric > small {
    font-size: 9px;
  }
  .expense-table-pagination {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }
  .expense-dashboard-grid {
    gap: 10px;
  }
  .expense-card {
    padding: 15px;
  }
  .expense-transactions-card {
    padding: 0;
  }
  .expense-transactions-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .expense-search {
    max-width: none;
  }
  .expense-category-filter,
  .expense-category-filter select {
    width: 100%;
  }
  .expense-chart {
    gap: 5px;
    height: 145px;
  }
  .expense-chart-track {
    width: 65%;
  }
  .expense-chart-label {
    font-size: 9px;
  }
  .expense-category-list {
    grid-template-columns: 1fr;
  }
  .expense-table {
    min-width: 670px;
  }
  .expense-table th,
  .expense-table td {
    padding: 11px 12px;
  }
  .expense-modal {
    padding: 18px;
  }
  .expense-modal-footer {
    align-items: flex-start;
    flex-direction: column;
  }
  .expense-modal-footer .expense-button {
    width: 100%;
  }
  .expense-form-grid {
    gap: 8px;
  }
  .expense-preview-stats {
    gap: 5px;
  }
  .expense-preview-stats div {
    padding: 9px;
  }
  .expense-preview-stats strong {
    font-size: 17px;
  }
}

</style>
