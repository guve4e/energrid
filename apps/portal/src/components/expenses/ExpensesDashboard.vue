<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { authFetch } from '../../auth/auth-client';

type Expense = {
  id: string;
  date: string;
  amount: number;
  currency: string;
  amountEur: number | null;
  fxRate?: number;
  category: string;
  description: string;
  tags: string[];
  liters?: number;
  legacyRecordId?: string;
};
type ImportPreview = {
  records: Omit<Expense, 'id'>[];
  total: number;
  valid: number;
  duplicates: number;
  errors: string[];
};
const props = defineProps<{ apiBase: string; accessToken: string }>();
const expenses = ref<Expense[]>([]);
const aiStatus = ref<{ available: boolean; provider: string | null } | null>(
  null,
);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const addOpen = ref(false);
const editingId = ref<string | null>(null);
const importOpen = ref(false);
const importPreview = ref<ImportPreview | null>(null);
const importName = ref('');
const importMessage = ref('');
const aiText = ref('');
const aiConsent = ref(false);
const aiError = ref('');
const aiDraft = ref(false);
const month = ref(localMonth());
const search = ref('');
const form = reactive({
  date: localDate(),
  amount: '',
  currency: 'EUR',
  fxRate: '',
  category: 'Groceries',
  description: '',
  tags: '',
  liters: '',
});

const categories = [
  'Groceries',
  'Restaurants',
  'Fuel',
  'Auto',
  'Home',
  'Utilities',
  'Health',
  'Personal',
  'Pets',
  'Entertainment',
  'Internet',
  'Mobile',
  'Cloud Services',
  'Streaming',
  'Software',
];
const monthExpenses = computed(() =>
  expenses.value.filter((item) => item.date.startsWith(month.value)),
);
const unconvertedCount = computed(
  () => monthExpenses.value.filter((item) => item.amountEur === null).length,
);
const monthTotal = computed(() =>
  monthExpenses.value.reduce((sum, item) => sum + euroAmount(item), 0),
);
const yearTotal = computed(() =>
  expenses.value
    .filter((item) => item.date.startsWith(month.value.slice(0, 4)))
    .reduce((sum, item) => sum + euroAmount(item), 0),
);
const dayCount = computed(() =>
  Math.max(
    1,
    Number(month.value.slice(5, 7)) === new Date().getMonth() + 1 &&
      Number(month.value.slice(0, 4)) === new Date().getFullYear()
      ? new Date().getDate()
      : new Date(
          Number(month.value.slice(0, 4)),
          Number(month.value.slice(5, 7)),
          0,
        ).getDate(),
  ),
);
const dailyAverage = computed(() => monthTotal.value / dayCount.value);
const categoryTotals = computed(() => {
  const totals = new Map<string, number>();
  for (const item of monthExpenses.value)
    totals.set(
      item.category,
      (totals.get(item.category) || 0) + euroAmount(item),
    );
  return [...totals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
});
const maxCategoryTotal = computed(() =>
  Math.max(1, ...categoryTotals.value.map((item) => item.total)),
);
const chartMonths = computed(() => {
  const [year, monthNumber] = month.value.split('-').map(Number);
  return Array.from({ length: 8 }, (_, index) => {
    const date = new Date(Date.UTC(year, monthNumber - 1 - 7 + index, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const total = expenses.value
      .filter((item) => item.date.startsWith(key))
      .reduce((sum, item) => sum + euroAmount(item), 0);
    return {
      key,
      label: new Intl.DateTimeFormat(undefined, {
        month: 'short',
        timeZone: 'UTC',
      }).format(date),
      total,
    };
  });
});
const maxMonthTotal = computed(() =>
  Math.max(1, ...chartMonths.value.map((item) => item.total)),
);
const filteredExpenses = computed(() => {
  const query = search.value.trim().toLowerCase();
  return [...expenses.value]
    .filter(
      (item) =>
        !query ||
        [item.category, item.description, item.tags.join(' ')]
          .join(' ')
          .toLowerCase()
          .includes(query),
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 100);
});
const formatEur = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value);
const formatNative = (item: Expense) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: item.currency,
    maximumFractionDigits: 2,
  }).format(item.amount);
const euroAmount = (item: Expense) =>
  item.amountEur ?? (item.currency === 'EUR' ? item.amount : 0);
const humanDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
const euroPercent = (value: number) =>
  `${Math.max(3, Math.round((value / maxCategoryTotal.value) * 100))}%`;

watch(aiText, () => {
  aiConsent.value = false;
  aiError.value = '';
});

async function api(path: string, init?: RequestInit) {
  const response = await authFetch(`${props.apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${props.accessToken}`,
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    let message = 'Your expenses could not be loaded. Please try again.';
    try {
      const body = await response.json();
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* Use the friendly fallback. */
    }
    throw new Error(message);
  }
  return response.json();
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const result = await api('/personal-expenses');
    expenses.value = result.expenses || [];
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'Your expenses could not be loaded.';
  } finally {
    loading.value = false;
  }
  try {
    aiStatus.value = await api('/personal-expenses/ai/status');
  } catch {
    aiStatus.value = { available: false, provider: null };
  }
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
        ? `/personal-expenses/${encodeURIComponent(editingId.value)}`
        : '/personal-expenses',
      {
        method: editingId.value ? 'PATCH' : 'POST',
        body: JSON.stringify({
          date: form.date,
          amount,
          currency: form.currency,
          ...(form.currency !== 'EUR' && form.fxRate
            ? { fxRate: Number(form.fxRate) }
            : {}),
          category: form.category.trim(),
          description: form.description.trim(),
          tags: form.tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          ...(form.category === 'Fuel' && form.liters
            ? { liters: Number(form.liters) }
            : {}),
        }),
      },
    );
    expenses.value = editingId.value
      ? expenses.value.map((item) =>
          item.id === result.expense.id ? result.expense : item,
        )
      : [result.expense, ...expenses.value];
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

function openAdd() {
  resetForm();
  aiDraft.value = false;
  addOpen.value = true;
}

function openEdit(item: Expense) {
  aiDraft.value = false;
  editingId.value = item.id;
  Object.assign(form, {
    date: item.date,
    amount: String(item.amount),
    currency: item.currency,
    fxRate: item.fxRate == null ? '' : String(item.fxRate),
    category: item.category,
    description: item.description,
    tags: item.tags.join(', '),
    liters: item.liters == null ? '' : String(item.liters),
  });
  addOpen.value = true;
}

async function draftFromDescription() {
  aiError.value = '';
  if (!aiText.value.trim()) {
    aiError.value = 'Describe one expense first.';
    return;
  }
  if (!aiConsent.value) {
    aiError.value =
      'Confirm AI processing before asking Energrid to read this description.';
    return;
  }
  busy.value = true;
  try {
    const result = await api('/personal-expenses/parse', {
      method: 'POST',
      body: JSON.stringify({
        text: aiText.value.trim(),
        cloudDataConsent: true,
      }),
    });
    const draft = result.draft;
    aiConsent.value = false;
    resetForm();
    Object.assign(form, {
      date: draft.date || localDate(),
      amount: draft.amount == null ? '' : String(draft.amount),
      currency: draft.currency || 'EUR',
      category: draft.category || 'Groceries',
      description: draft.description || '',
      tags: Array.isArray(draft.tags) ? draft.tags.join(', ') : '',
      liters: draft.liters == null ? '' : String(draft.liters),
    });
    aiDraft.value = true;
    addOpen.value = true;
  } catch (cause) {
    aiError.value =
      cause instanceof Error
        ? cause.message
        : 'Energrid could not prepare that expense.';
  } finally {
    busy.value = false;
  }
}

async function deleteExpense(item: Expense) {
  if (!window.confirm(`Delete “${item.description}”?`)) return;
  try {
    await api(`/personal-expenses/${encodeURIComponent(item.id)}`, {
      method: 'DELETE',
    });
    expenses.value = expenses.value.filter((expense) => expense.id !== item.id);
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'The expense could not be deleted.';
  }
}

async function inspectImport(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  importPreview.value = null;
  importMessage.value = '';
  error.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    error.value =
      'That file is over 5 MB. Split the export into smaller files and import them one at a time.';
    return;
  }
  importName.value = file.name;
  busy.value = true;
  try {
    const text = await file.text();
    let records: unknown;
    try {
      records = JSON.parse(text);
    } catch {
      records = text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    }
    importPreview.value = await api('/personal-expenses/import/preview', {
      method: 'POST',
      body: JSON.stringify({ records }),
    });
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'This file could not be read. Use a JSON or JSON Lines export.';
  } finally {
    busy.value = false;
  }
}

async function confirmImport() {
  if (!importPreview.value?.records.length) return;
  busy.value = true;
  importMessage.value = '';
  error.value = '';
  try {
    const result = await api('/personal-expenses/import', {
      method: 'POST',
      body: JSON.stringify({ records: importPreview.value.records }),
    });
    importMessage.value = `Imported ${result.imported} expenses${result.skippedDuplicates ? ` · skipped ${result.skippedDuplicates} duplicates` : ''}${result.rejected ? ` · ${result.rejected} needs attention` : ''}.`;
    importPreview.value = null;
    await load();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'The import did not finish. Your original file is unchanged.';
  } finally {
    busy.value = false;
  }
}

function openImport() {
  importOpen.value = true;
  importPreview.value = null;
  importMessage.value = '';
  importName.value = '';
}
function resetForm() {
  editingId.value = null;
  Object.assign(form, {
    date: localDate(),
    amount: '',
    currency: 'EUR',
    fxRate: '',
    category: 'Groceries',
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
  <section class="expenses-page" aria-labelledby="expenses-title">
    <header class="expenses-heading">
      <div>
        <p class="eyebrow">Personal finance</p>
        <h1 id="expenses-title">Your spending, in one place.</h1>
        <p class="expenses-subtitle">
          A clear view of where your money goes, month by month.
        </p>
      </div>
      <div class="expenses-actions">
        <button
          class="expense-button expense-button--quiet"
          type="button"
          @click="openImport"
        >
          Import old data
        </button>
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
    <p v-if="importMessage" class="expense-success" role="status">
      {{ importMessage }}
    </p>
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

    <article class="expense-ai-capture">
      <div class="expense-ai-mark" aria-hidden="true">✦</div>
      <div class="expense-ai-copy">
        <p class="eyebrow">Low-effort capture</p>
        <h2>Tell Energrid what you spent.</h2>
        <p>
          Type or dictate a sentence. Energrid will draft the date, amount and
          category for you to review.
        </p>
      </div>
      <div class="expense-ai-controls">
        <label class="sr-only" for="expense-natural-input"
          >Describe an expense</label
        >
        <textarea
          id="expense-natural-input"
          v-model="aiText"
          rows="2"
          maxlength="1200"
          placeholder="For example: €28.57 at Lidl for groceries today"
        ></textarea>
        <label class="expense-ai-consent"
          ><input v-model="aiConsent" type="checkbox" /><span
            >I agree to send this description to Energrid’s configured AI
            provider. It will not be saved until I review and confirm the
            draft.</span
          ></label
        >
        <div class="expense-ai-actions">
          <span v-if="!aiStatus?.available" class="expense-ai-unavailable"
            >AI capture is not configured for this Energrid environment
            yet.</span
          ><span v-else class="expense-ai-provider"
            >Configured provider: {{ aiStatus.provider }}</span
          ><button
            class="expense-button expense-button--primary"
            type="button"
            :disabled="busy || !aiStatus?.available"
            @click="draftFromDescription"
          >
            {{ busy ? 'Preparing…' : 'Draft expense' }}
          </button>
        </div>
        <p v-if="aiError" class="expense-ai-error" role="alert">
          {{ aiError }}
        </p>
      </div>
    </article>

    <div class="expense-metrics">
      <article class="expense-metric expense-metric--featured">
        <span>This month</span><strong>{{ formatEur(monthTotal) }}</strong
        ><small>{{ monthExpenses.length }} recorded expenses</small>
        <div class="expense-metric-glow" aria-hidden="true"></div>
      </article>
      <article class="expense-metric">
        <span>Daily pace</span><strong>{{ formatEur(dailyAverage) }}</strong
        ><small>Average per day this month</small>
      </article>
      <article class="expense-metric">
        <span>Year to date</span><strong>{{ formatEur(yearTotal) }}</strong
        ><small>{{ month.slice(0, 4) }} · all categories</small>
      </article>
      <article class="expense-metric">
        <span>Top category</span
        ><strong class="expense-metric-category">{{
          categoryTotals[0]?.name || '—'
        }}</strong
        ><small>{{
          categoryTotals[0]
            ? formatEur(categoryTotals[0].total) + ' this month'
            : 'No expenses this month'
        }}</small>
      </article>
    </div>

    <div class="expense-dashboard-grid">
      <article class="expense-card expense-trend-card">
        <div class="expense-card-heading">
          <div>
            <h2>Monthly spending</h2>
            <p>Last eight months · converted to EUR</p>
          </div>
          <span class="expense-chart-total">{{ formatEur(monthTotal) }}</span>
        </div>
        <div
          class="expense-chart"
          role="img"
          :aria-label="`Monthly expenses for the last eight months. Selected month total ${formatEur(monthTotal)}.`"
        >
          <div
            v-for="item in chartMonths"
            :key="item.key"
            class="expense-chart-column"
            :class="{ selected: item.key === month }"
          >
            <span class="expense-chart-value">{{
              item.total >= 1000
                ? `${(item.total / 1000).toFixed(1)}k`
                : Math.round(item.total)
            }}</span>
            <div class="expense-chart-track">
              <div
                class="expense-chart-bar"
                :style="{
                  height: `${Math.max(3, (item.total / maxMonthTotal) * 100)}%`,
                }"
              ></div>
            </div>
            <span class="expense-chart-label">{{ item.label }}</span>
          </div>
        </div>
        <div class="expense-chart-foot">
          <span><i></i> Total expenses</span
          ><span>{{ month.slice(0, 4) }}</span>
        </div>
      </article>

      <article class="expense-card expense-categories-card">
        <div class="expense-card-heading">
          <div>
            <h2>Where it goes</h2>
            <p>
              Category totals for
              {{
                new Intl.DateTimeFormat(undefined, {
                  month: 'long',
                  timeZone: 'UTC',
                }).format(new Date(`${month}-15T00:00:00Z`))
              }}
            </p>
          </div>
        </div>
        <div v-if="categoryTotals.length" class="expense-category-list">
          <div
            v-for="item in categoryTotals.slice(0, 7)"
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
          ><strong>A fresh month starts here</strong>
          <p>Choose a different month or add your first expense.</p>
        </div>
      </article>
    </div>

    <article class="expense-card expense-transactions-card">
      <div class="expense-card-heading expense-transactions-heading">
        <div>
          <h2>Transactions</h2>
          <p>Recent activity across your history</p>
        </div>
        <label class="expense-search"
          ><span aria-hidden="true">⌕</span
          ><input
            v-model="search"
            type="search"
            placeholder="Search merchant, category or tag"
            aria-label="Search expenses"
        /></label>
      </div>
      <div v-if="loading" class="expense-empty-state">
        Loading transaction history…
      </div>
      <div v-else-if="!filteredExpenses.length" class="expense-empty-state">
        <span class="expense-empty-icon">＋</span
        ><strong>No transactions match this view</strong>
        <p>Add an expense or import your previous history to get started.</p>
        <div class="expense-empty-actions">
          <button
            class="expense-button expense-button--primary"
            type="button"
            @click="openAdd"
          >
            Add an expense</button
          ><button
            class="expense-button expense-button--quiet"
            type="button"
            @click="openImport"
          >
            Import history
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
                  @click="openEdit(item)"
                >
                  ↗
                </button>
                <button
                  class="expense-delete"
                  type="button"
                  :aria-label="`Delete ${item.description}`"
                  @click="deleteExpense(item)"
                >
                  ×
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="filteredExpenses.length === 100"
          class="expense-table-footnote"
        >
          Showing the latest 100 matching transactions.
        </p>
      </div>
    </article>

    <section class="expense-capture-note">
      <div class="expense-capture-icon">✦</div>
      <div>
        <strong>Capture should take seconds</strong>
        <p>
          History import and quick entry are ready. Receipt scanning, voice
          capture, and bank connections can follow as separate, reviewable
          sources.
        </p>
      </div>
      <button
        class="expense-button expense-button--quiet"
        type="button"
        @click="openImport"
      >
        Bring in your history
      </button>
    </section>

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
        <p v-if="aiDraft" class="expense-ai-review">
          AI prepared this draft. Check the date, amount, currency and category
          before saving.
        </p>
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
                <option>BGN</option>
                <option>USD</option>
              </select></label
            ><label
              >Category<input
                v-model="form.category"
                list="expense-category-options"
                required
                maxlength="80" /><datalist id="expense-category-options">
                <option
                  v-for="category in categories"
                  :key="category"
                  :value="category"
                ></option></datalist
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
          <label v-if="form.category === 'Fuel'"
            >Fuel volume <span class="expense-optional">liters</span
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

    <div
      v-if="importOpen"
      class="expense-modal-backdrop"
      @click.self="importOpen = false"
    >
      <section
        class="expense-modal expense-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-expense-title"
      >
        <div class="expense-modal-heading">
          <div>
            <p class="eyebrow">Move your history</p>
            <h2 id="import-expense-title">Import old expenses</h2>
            <p class="expense-modal-lead">
              Choose a JSON or JSON Lines export from your old app. The preview
              checks each record before anything is saved.
            </p>
          </div>
          <button
            class="expense-modal-close"
            type="button"
            aria-label="Close"
            @click="importOpen = false"
          >
            ×
          </button>
        </div>
        <label class="expense-dropzone"
          ><input
            type="file"
            accept=".json,.jsonl,.ndjson,application/json"
            @change="inspectImport"
          /><span class="expense-upload-symbol">↑</span
          ><strong>{{ importName || 'Choose your export file' }}</strong
          ><small
            >MongoDB JSON, JSON array, or JSON Lines · up to 5 MB</small
          ></label
        >
        <p v-if="busy" class="expense-import-status" role="status">
          Reading and checking records…
        </p>
        <div v-if="importPreview" class="expense-preview">
          <div class="expense-preview-stats">
            <div>
              <strong>{{ importPreview.valid }}</strong
              ><span>ready to import</span>
            </div>
            <div>
              <strong>{{ importPreview.duplicates }}</strong
              ><span>already imported</span>
            </div>
            <div>
              <strong>{{ importPreview.total }}</strong
              ><span>records found</span>
            </div>
          </div>
          <div v-if="importPreview.errors.length" class="expense-import-errors">
            <strong
              >{{
                importPreview.total -
                importPreview.valid -
                importPreview.duplicates
              }}
              records need attention</strong
            >
            <ul>
              <li v-for="problem in importPreview.errors" :key="problem">
                {{ problem }}
              </li>
            </ul>
          </div>
          <div class="expense-preview-examples">
            <strong>Data kept from your old entries</strong>
            <p>
              Date, amount and original currency, EUR conversion and rate,
              category, description, tags, fuel liters, and source ID where
              present.
            </p>
          </div>
        </div>
        <div class="expense-modal-footer">
          <span
            >The import can be repeated safely; source IDs prevent
            duplicates.</span
          ><button
            class="expense-button expense-button--primary"
            type="button"
            :disabled="busy || !importPreview?.valid"
            @click="confirmImport"
          >
            {{
              busy
                ? 'Importing…'
                : `Import ${importPreview?.valid || 0} expenses`
            }}
          </button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.expenses-page {
  --ink: #102326;
  --muted: #718184;
  --line: #e3e9e5;
  --surface: #fff;
  --mint: #d8f36c;
  --deep: #17393b;
  color: var(--ink);
  display: grid;
  gap: 22px;
  padding: 4px 0 34px;
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
  font-size: clamp(27px, 3vw, 38px);
  letter-spacing: -0.045em;
  line-height: 1.12;
  margin: 7px 0;
}
.expenses-subtitle,
.expense-card-heading p,
.expense-capture-note p,
.expense-modal-lead {
  color: var(--muted);
  font-size: 13px;
}
.expenses-page .eyebrow {
  color: #618d36;
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
  background: var(--deep);
  color: #fff;
  box-shadow: 0 9px 20px #17393b1c;
}
.expense-period-row {
  border-top: 1px solid var(--line);
  padding-top: 16px;
}
.expense-ai-capture {
  align-items: flex-start;
  background: linear-gradient(115deg, #f5f8f0, #fbfcf8);
  border: 1px solid #e2eadb;
  border-radius: 15px;
  display: grid;
  gap: 15px;
  grid-template-columns: 38px minmax(180px, 0.7fr) minmax(300px, 1.3fr);
  padding: 17px;
}
.expense-ai-mark {
  align-items: center;
  background: #e6efdc;
  border-radius: 11px;
  color: #67884a;
  display: grid;
  font-size: 18px;
  height: 38px;
  justify-items: center;
}
.expense-ai-copy h2 {
  color: var(--deep);
  font-size: 15px;
  letter-spacing: -0.025em;
  margin: 5px 0;
}
.expense-ai-copy > p:last-child {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.45;
}
.expense-ai-controls {
  display: grid;
  gap: 8px;
}
.expense-ai-controls textarea {
  background: #fff;
  border: 1px solid #e1e8dd;
  border-radius: 9px;
  color: var(--ink);
  font-size: 11px;
  min-height: 58px;
  padding: 10px;
  resize: vertical;
  width: 100%;
}
.expense-ai-consent {
  align-items: flex-start;
  color: #7d8b82;
  display: flex;
  font-size: 9px;
  gap: 7px;
  line-height: 1.4;
  margin: 0;
}
.expense-ai-consent input {
  accent-color: #547c43;
  flex: none;
  margin: 1px 0 0;
}
.expense-ai-actions {
  align-items: center;
  display: flex;
  gap: 10px;
  justify-content: space-between;
}
.expense-ai-provider,
.expense-ai-unavailable {
  color: #87948b;
  font-size: 9px;
}
.expense-ai-error {
  color: #a63f35;
  font-size: 10px;
}
.expense-ai-review {
  background: #f2f7e9;
  border-radius: 8px;
  color: #668148;
  font-size: 10px;
  line-height: 1.45;
  margin: -6px 0 16px;
  padding: 9px 11px;
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
.expense-metrics {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
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
  background: linear-gradient(135deg, #193c3d, #28524a);
  border: 0;
  color: #fff;
}
.expense-metric--featured > span,
.expense-metric--featured > small {
  color: #d4e4d6;
}
.expense-metric-glow {
  background: radial-gradient(ellipse, #d8f36c49, transparent 68%);
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
}
.expense-chart {
  align-items: end;
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  height: 170px;
  padding-top: 18px;
}
.expense-chart-column {
  align-items: center;
  display: grid;
  grid-template-rows: 18px 1fr 20px;
  height: 100%;
  justify-items: center;
  min-width: 0;
}
.expense-chart-value {
  color: #a2aeaa;
  font-size: 9px;
}
.expense-chart-track {
  align-items: end;
  background: #f1f5f1;
  border-radius: 7px 7px 2px 2px;
  display: flex;
  height: 100%;
  overflow: hidden;
  width: min(28px, 80%);
}
.expense-chart-bar {
  background: linear-gradient(180deg, #96be59, #547b49);
  border-radius: 7px 7px 0 0;
  min-height: 2px;
  transition: height 0.25s;
}
.expense-chart-column.selected .expense-chart-track {
  background: #e8f3d5;
}
.expense-chart-column.selected .expense-chart-bar {
  background: linear-gradient(180deg, #d8f36c, #739f49);
}
.expense-chart-column.selected .expense-chart-label {
  color: var(--deep);
  font-weight: 800;
}
.expense-chart-label {
  color: #98a4a1;
  font-size: 10px;
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
  background: #88ae50;
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
  background: #89ad58;
  border-radius: 20px;
  display: block;
  height: 100%;
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
  background: #eff5e8;
  border-radius: 30px;
  color: #63834b;
  display: inline-block;
  font-size: 10px;
  padding: 5px 9px;
  white-space: nowrap;
}
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
.expense-capture-note {
  align-items: center;
  background: #f4f7f0;
  border: 1px solid #e4ebda;
  border-radius: 13px;
  display: flex;
  gap: 13px;
  padding: 15px 18px;
}
.expense-capture-icon {
  align-items: center;
  background: #e4efcf;
  border-radius: 10px;
  color: #648143;
  display: grid;
  flex: none;
  height: 36px;
  place-items: center;
  width: 36px;
}
.expense-capture-note strong {
  color: #334e3b;
  font-size: 12px;
}
.expense-capture-note p {
  font-size: 10px;
  margin-top: 3px;
}
.expense-capture-note .expense-button {
  margin-left: auto;
  white-space: nowrap;
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
  .expense-ai-capture {
    grid-template-columns: 38px minmax(0, 1fr);
  }
  .expense-ai-controls {
    grid-column: 2;
  }
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
  .expense-capture-note {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .expense-capture-note .expense-button {
    margin-left: 49px;
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
  .expense-dashboard-grid {
    gap: 10px;
  }
  .expense-ai-capture {
    grid-template-columns: 32px minmax(0, 1fr);
    padding: 13px;
  }
  .expense-ai-mark {
    height: 32px;
    width: 32px;
  }
  .expense-ai-actions {
    align-items: flex-start;
    flex-direction: column;
  }
  .expense-ai-actions .expense-button {
    width: 100%;
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
  .expense-capture-note {
    padding: 12px;
  }
  .expense-capture-note p {
    line-height: 1.5;
  }
  .expense-capture-note .expense-button {
    margin-left: 49px;
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
