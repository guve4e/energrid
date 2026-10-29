<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
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
const chartEndMonth = ref(month.value);
const search = ref('');
const categoryFilter = ref('');
const transactionPage = ref(1);
const transactionPageSize = 50;
const categories = ref<FinanceCategory[]>([]);
const categoriesOpen = ref(false);
const receiptOpen = ref(false);
const receiptConsent = ref(false);
const receiptRetryConsent = ref(false);
const receiptInput = ref<HTMLInputElement | null>(null);
const receiptBusy = ref(false);
const receiptImageUrl = ref('');
const receiptDraftId = ref('');
const receiptId = ref('');
const receiptHasBeenReviewed = ref(false);
const receiptDuplicate = ref(false);
const receiptPossibleMatches = ref<Expense[]>([]);
const receiptWarnings = ref<string[]>([]);
const receiptFieldWarnings = ref<Partial<Record<'merchant' | 'date' | 'currency' | 'total', string>>>({});
const receiptReviewDirty = ref(false);
const receiptSaveError = ref('');
const receiptReconciliation = ref<{ matched: boolean | null; itemTotal: string | null; total: string | null; difference: string | null; adjustmentTotal: string | null; inconsistentLineCount: number; extractedLineCount: number; completeLineCount: number; incompleteLineCount: number; reportedArticleCount: number | null; articleCountMismatch: boolean | null; warnings: string[] } | null>(null);
const receiptExtractionDiagnostics = ref<{ responseStatus: string; outputTokens?: number; modelItemCount: number; validatedItemCount: number; persistedExtractionItemCount: number; completeDraftItemCount: number; incompleteExtractionItemCount: number; completeButUnmappedItemCount: number; reportedArticleCount: number | null } | null>(null);
const receiptTotalOnly = ref(false);
const receiptForm = reactive({ date: '', amount: '', currency: 'EUR', merchantName: '', category: '', description: '' });
type ReviewItem = { description: string; normalizedDescription: string; suggestedCategory: string; confidence: number | null; uncertainty: string | null; quantity: string; unit: string; packaging: string; unitPrice: string; discount: string; tax: string; taxIncluded: '' | 'true' | 'false'; lineTotal: string; currency: string; categoryId: string | null; sourceReceiptId: string | null; extractionProvenance: Record<string, unknown> | null };
type ReviewAdjustment = { label: string; kind: 'tax' | 'discount' | 'deposit' | 'return' | 'rounding' | 'other'; amount: string; signedAmount: string | null; includedInTotal: '' | 'true' | 'false'; includedInLineTotal: '' | 'true' | 'false'; relatedPurchaseIndex: number | null };
const receiptItems = ref<ReviewItem[]>([]);
const receiptAdjustments = ref<ReviewAdjustment[]>([]);
const receiptSourceText = ref('');
const receiptDocumentEntries = ref<any[]>([]);
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
const chartEndMonthLabel = computed(() => new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${chartEndMonth.value}-15T00:00:00Z`)));
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
  const byMonth = Array.isArray(allHistorySummary.value.byMonth) ? allHistorySummary.value.byMonth : [];
  return byMonth
    .filter((item) => item.count > 0 && item.month <= chartEndMonth.value)
    .slice(-8)
    .map((summary) => {
      const [year, monthNumber] = summary.month.split('-').map(Number);
      const date = new Date(Date.UTC(year, monthNumber - 1, 1));
      return {
        key: summary.month,
        summary: { total: summary.total, transactionCount: summary.count },
        total: Number(summary.total),
        monthLabel: new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(date),
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
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const headers = new Headers(init?.headers || {});
  headers.set('Authorization', `Bearer ${props.accessToken}`);
  if (!isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await authFetch(`${props.apiBase}${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  let body: any = null;
  if (text) { try { body = JSON.parse(text); } catch { /* handled below */ } }
  if (!response.ok) throw new Error(typeof body?.message === 'string' ? body.message : `The request failed (${response.status}). Please try again.`);
  if (!text) return null;
  if (body === null) throw new Error(`The server returned an unreadable response (${response.status}). Please retry.`);
  return body;
}

function openReceiptCapture() {
  closeReceiptReview();
  receiptConsent.value = false;
  receiptDuplicate.value = false;
  receiptPossibleMatches.value = [];
  receiptWarnings.value = [];
  receiptFieldWarnings.value = {};
  receiptSaveError.value = '';
  receiptReconciliation.value = null;
  receiptExtractionDiagnostics.value = null;
  receiptRetryConsent.value = false;
  receiptOpen.value = true;
}

function handleReceiptInput(event: Event) {
  void uploadReceipt((event.target as HTMLInputElement).files?.[0]);
}

async function uploadReceipt(file?: File) {
  if (!file) return;
  if (!receiptConsent.value) { error.value = 'Please consent to cloud processing before selecting a receipt image.'; return; }
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 10 * 1024 * 1024) { error.value = 'Choose a JPEG or PNG image no larger than 10 MB.'; return; }
  receiptBusy.value = true;
  error.value = '';
  try {
    const data = new FormData();
    data.append('receipt', file);
    data.append('cloudDataConsent', 'true');
    const result = await api('/personal-finance/receipts/extract', { method: 'POST', body: data });
    if (!result.draft) {
      error.value = 'This receipt was already uploaded. Its existing transaction remains unchanged.';
      return;
    }
    await applyReceiptExtractionResult(result);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Receipt extraction failed.'; }
  finally { receiptBusy.value = false; if (receiptInput.value) receiptInput.value.value = ''; }
}

async function applyReceiptExtractionResult(result: any) {
  const draft = result.draft;
  receiptDraftId.value = draft.id;
  const receipt = result.receipt ?? draft.receipts?.[0];
  const extraction = receipt?.extraction;
  receiptDuplicate.value = result.duplicate === true;
  receiptPossibleMatches.value = result.possibleMatches || [];
  receiptReconciliation.value = result.reconciliation ?? null;
  receiptExtractionDiagnostics.value = result.extractionDiagnostics ?? null;
  Object.assign(receiptForm, {
    date: draft.date ?? extraction?.date?.value ?? '', amount: draft.amount ?? extraction?.total?.value ?? '',
    currency: draft.currency ?? extraction?.currency?.value ?? 'EUR', merchantName: draft.merchantName ?? extraction?.merchant?.value ?? '',
    category: draft.category ?? '', description: draft.description ?? extraction?.merchant?.value ?? '',
  });
  receiptId.value = receipt?.id ?? '';
  receiptHasBeenReviewed.value = Boolean(receipt?.userReviewedAt);
  receiptSourceText.value = extraction?.sourceText ?? '';
  receiptDocumentEntries.value = extraction?.documentEntries ?? [];
  receiptAdjustments.value = (receipt?.reviewedAdjustments ?? extraction?.adjustments ?? []).map((adjustment: any) => ({
    label: adjustment.label ?? '', kind: adjustment.kind ?? 'other', amount: adjustment.amount ?? '', signedAmount: adjustment.signedAmount ?? null,
    includedInTotal: typeof adjustment.includedInTotal === 'boolean' ? String(adjustment.includedInTotal) as 'true' | 'false' : '',
    includedInLineTotal: typeof adjustment.includedInLineTotal === 'boolean' ? String(adjustment.includedInLineTotal) as 'true' | 'false' : '',
    relatedPurchaseIndex: adjustment.relatedPurchaseIndex ?? null,
  }));
  receiptWarnings.value = [...(result.reconciliation?.warnings ?? []), ...(extraction?.warnings ?? [])];
  receiptFieldWarnings.value = {};
  for (const [label, field] of Object.entries({ merchant: extraction?.merchant, date: extraction?.date, currency: extraction?.currency, total: extraction?.total })) {
    if ((field as any)?.uncertainty) receiptFieldWarnings.value[label as keyof typeof receiptFieldWarnings.value] = (field as any).uncertainty;
    else if ((field as any)?.confidence !== null && (field as any)?.confidence !== undefined && (field as any).confidence < 0.7) receiptFieldWarnings.value[label as keyof typeof receiptFieldWarnings.value] = `Please check this value (${Math.round((field as any).confidence * 100)}% confidence).`;
  }
  const fieldValue = (value: any) => value && typeof value === 'object' && 'value' in value ? value.value : value;
  const itemsForReview = receipt?.userReviewedAt ? draft.items ?? [] : extraction?.items ?? draft.items ?? [];
  receiptItems.value = itemsForReview.map((item: any) => ({
    description: fieldValue(item.description ?? item.originalDescription) ?? '', normalizedDescription: fieldValue(item.normalizedDescription) ?? '',
    quantity: fieldValue(item.quantity) ?? '', unit: fieldValue(item.unit) ?? '', packaging: fieldValue(item.packaging) ?? '',
    unitPrice: fieldValue(item.unitPrice) ?? '', discount: fieldValue(item.discount) ?? '', tax: fieldValue(item.tax) ?? '',
    taxIncluded: typeof fieldValue(item.taxIncluded) === 'boolean' ? String(fieldValue(item.taxIncluded)) as 'true' | 'false' : '',
    lineTotal: fieldValue(item.lineTotal) ?? '', currency: receiptForm.currency, suggestedCategory: fieldValue(item.suggestedCategory) ?? '',
    confidence: item.originalDescription?.confidence ?? null, uncertainty: item.originalDescription?.uncertainty ?? null,
    categoryId: item.categoryId ?? categories.value.find((category) => category.name.toLocaleLowerCase() === String(fieldValue(item.suggestedCategory) ?? '').toLocaleLowerCase())?.id ?? null,
    sourceReceiptId: receipt?.id ?? item.sourceReceiptId ?? null,
    extractionProvenance: item.extractionProvenance ?? { provider: receipt?.parserProvider, schemaVersion: extraction?.schemaVersion, sourceContentHash: receipt?.contentHash },
  }));
  receiptTotalOnly.value = false;
  receiptRetryConsent.value = false;
  receiptReviewDirty.value = false;
  receiptSaveError.value = '';
  if (receiptId.value) {
    const imageResponse = await authFetch(`${props.apiBase}/personal-finance/receipts/${encodeURIComponent(receiptId.value)}/content`, { headers: { Authorization: `Bearer ${props.accessToken}` } });
    if (imageResponse.ok) {
      if (receiptImageUrl.value) URL.revokeObjectURL(receiptImageUrl.value);
      receiptImageUrl.value = URL.createObjectURL(await imageResponse.blob());
    }
  }
}

async function reextractReceipt() {
  if (!receiptRetryConsent.value || !receiptId.value) return;
  receiptBusy.value = true;
  receiptSaveError.value = '';
  error.value = '';
  try {
    const result = await api(`/personal-finance/receipts/${encodeURIComponent(receiptId.value)}/re-extract`, {
      method: 'POST', body: JSON.stringify({ cloudDataConsent: true }),
    });
    await applyReceiptExtractionResult(result);
  } catch (cause) { receiptSaveError.value = cause instanceof Error ? cause.message : 'Receipt re-extraction failed; the previous draft remains unchanged.'; }
  finally { receiptBusy.value = false; receiptRetryConsent.value = false; }
}

async function openReceiptDraftFromLink(draftId: string) {
  try {
    const result = await api(`/personal-finance/drafts/${encodeURIComponent(draftId)}`);
    const draft = result.draft;
    const receipt = draft?.receipts?.find((item: any) => item.status === 'review_required') ?? draft?.receipts?.[0];
    if (!draft || !receipt) throw new Error('This expense draft has no attached receipt to review.');
    await applyReceiptExtractionResult({ draft, receipt, reconciliation: result.reconciliation });
    receiptOpen.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not open the saved receipt draft.';
  }
}

function receiptReviewPayload() {
  return {
    ...receiptForm,
    description: receiptForm.description.trim() || receiptForm.merchantName.trim(),
    categoryId: categories.value.find((category) => category.name === receiptForm.category)?.id ?? null,
    itemizationReviewed: true,
    totalOnly: receiptTotalOnly.value,
    items: receiptTotalOnly.value ? [] : receiptItems.value.map((item) => ({
      description: item.description, productCode: null, quantity: item.quantity, unit: item.unit, unitPrice: item.unitPrice,
      discount: item.discount, tax: item.tax, lineTotal: item.lineTotal, currency: item.currency,
      sourceReceiptId: item.sourceReceiptId, normalizedDescription: item.normalizedDescription || null,
      packaging: item.packaging || null, taxIncluded: item.taxIncluded === 'true', categoryId: item.categoryId,
      extractionProvenance: item.extractionProvenance,
    })),
    adjustments: receiptAdjustments.value.map((adjustment) => ({ label: adjustment.label, kind: adjustment.kind, amount: adjustment.amount || null, signedAmount: adjustment.signedAmount, includedInTotal: adjustment.includedInTotal === '' ? null : adjustment.includedInTotal === 'true', includedInLineTotal: adjustment.includedInLineTotal === '' ? null : adjustment.includedInLineTotal === 'true', relatedPurchaseIndex: adjustment.relatedPurchaseIndex })),
  };
}

async function confirmReceiptDraft() {
  receiptSaveError.value = '';
  if (!receiptDraftId.value || !receiptForm.category || !receiptForm.date || !receiptForm.amount || !(receiptForm.description.trim() || receiptForm.merchantName.trim())) { receiptSaveError.value = 'Add a date, total, category, and merchant before saving.'; return; }
  if (receiptReconciliation.value?.matched !== true && !receiptReviewDirty.value && !receiptTotalOnly.value) { receiptSaveError.value = 'Review the receipt amounts before saving. The current itemization has not been verified against its printed total.'; return; }
  if (!receiptTotalOnly.value && receiptItems.value.some((item) => !item.description || !item.quantity || !item.unit || !item.unitPrice || item.discount === '' || item.tax === '' || !item.lineTotal || item.taxIncluded === '')) { receiptSaveError.value = 'Complete the item details, or choose “Save without item details.”'; return; }
  receiptBusy.value = true;
  try {
    const reviewed = await api(`/personal-finance/drafts/${encodeURIComponent(receiptDraftId.value)}`, { method: 'PATCH', body: JSON.stringify(receiptReviewPayload()) });
    receiptReconciliation.value = reviewed.reconciliation ?? null;
    receiptReviewDirty.value = false;
    if (!receiptTotalOnly.value && receiptReconciliation.value?.matched !== true) {
      receiptSaveError.value = receiptReconciliation.value?.warnings?.[0] ?? 'The reviewed items do not match the receipt total. Correct the amounts or choose to save without item details.';
      return;
    }
    await api(`/personal-finance/drafts/${encodeURIComponent(receiptDraftId.value)}/confirm`, { method: 'POST' });
    closeReceiptReview();
    await load();
  } catch (cause) { receiptSaveError.value = cause instanceof Error ? cause.message : 'The receipt expense could not be saved. Review the total and item amounts.'; }
  finally { receiptBusy.value = false; }
}

function markReceiptReviewDirty(affectsTotals = false, field?: keyof typeof receiptFieldWarnings.value) {
  if (affectsTotals) receiptReviewDirty.value = true;
  if (field) receiptFieldWarnings.value = { ...receiptFieldWarnings.value, [field]: undefined };
  receiptSaveError.value = '';
}

function formatReceiptMoney(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: receiptForm.currency, maximumFractionDigits: 2 }).format(Number(value));
}

async function attachReceiptMatch(expense: Expense) {
  if (!receiptId.value) return;
  receiptBusy.value = true;
  try {
    await api(`/personal-finance/receipts/${encodeURIComponent(receiptId.value)}/attach`, { method: 'POST', body: JSON.stringify({ expenseId: expense.id }) });
    closeReceiptReview();
    await load();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'The receipt could not be attached.'; }
  finally { receiptBusy.value = false; }
}

async function rejectReceiptDraft() {
  if (receiptDraftId.value) await api(`/personal-finance/drafts/${encodeURIComponent(receiptDraftId.value)}/reject`, { method: 'POST' }).catch(() => undefined);
  closeReceiptReview();
}

function closeReceiptReview() {
  receiptOpen.value = false;
  if (receiptImageUrl.value) URL.revokeObjectURL(receiptImageUrl.value);
  receiptImageUrl.value = '';
  receiptDraftId.value = '';
  receiptId.value = '';
  receiptHasBeenReviewed.value = false;
  receiptItems.value = [];
  receiptAdjustments.value = [];
  receiptDocumentEntries.value = [];
  receiptFieldWarnings.value = {};
  receiptReviewDirty.value = false;
  receiptSaveError.value = '';
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

function handleReportingMonthChange(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (!value) return;
  const monthChanged = month.value !== value;
  chartEndMonth.value = value;
  if (monthChanged) month.value = value;
  else void refreshSummaries().catch(setRequestError);
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

onMounted(async () => {
  await load();
  const receiptDraftIdFromLink = new URLSearchParams(window.location.search).get('receiptDraft');
  if (receiptDraftIdFromLink) await openReceiptDraftFromLink(receiptDraftIdFromLink);
});
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  if (receiptImageUrl.value) URL.revokeObjectURL(receiptImageUrl.value);
});
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
        <button class="expense-button expense-button--quiet" type="button" @click="openReceiptCapture">Scan receipt</button>
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
          :value="month"
          @change="handleReportingMonthChange"
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
            <p>Recent months with recorded spending · EUR</p>
          </div>
          <span class="expense-chart-total">
            <small v-if="chartFocusMonth">{{ chartFocusMonth.fullLabel }}</small>
            {{ formatEur(chartFocusMonth?.summary?.total ?? '0') }}
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

    <div v-if="receiptOpen" class="expense-modal-backdrop" @click.self="closeReceiptReview">
      <section class="expense-modal receipt-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
        <div class="expense-modal-heading">
          <div><p class="eyebrow">Receipt intelligence</p><h2 id="receipt-title">{{ receiptDraftId ? 'Review receipt' : 'Scan receipt' }}</h2></div>
          <button class="expense-modal-close" type="button" aria-label="Close receipt review" @click="closeReceiptReview">×</button>
        </div>
        <div class="receipt-modal-content">
          <div v-if="!receiptDraftId" class="receipt-consent">
            <p>Receipt images contain personal information. With your permission, this image will be sent to the configured cloud vision provider for extraction and stored privately in your account.</p>
            <label><input v-model="receiptConsent" type="checkbox" /> I consent to cloud processing of this receipt image.</label>
            <input ref="receiptInput" class="sr-only" type="file" accept="image/jpeg,image/png" capture="environment" :disabled="!receiptConsent || receiptBusy" @change="handleReceiptInput" />
            <button class="expense-button expense-button--primary" type="button" :disabled="!receiptConsent || receiptBusy" @click="receiptInput?.click()">{{ receiptBusy ? 'Reading receipt…' : 'Choose or photograph receipt' }}</button>
            <p class="expense-optional">JPEG or PNG · up to 10 MB.</p>
            <p v-if="error" class="receipt-error" role="alert">{{ error }}</p>
          </div>
          <div v-else class="receipt-review">
            <p v-if="receiptDuplicate" class="receipt-notice" role="status">This receipt was already uploaded. Its existing draft is shown; it will not create another receipt.</p>
            <div class="receipt-review-fields">
              <label class="receipt-primary-field">Merchant<input v-model="receiptForm.merchantName" maxlength="180" placeholder="Enter merchant" @input="markReceiptReviewDirty(false, 'merchant')" /><small v-if="receiptFieldWarnings.merchant" class="receipt-field-warning">{{ receiptFieldWarnings.merchant }}</small></label>
              <label>Date<input v-model="receiptForm.date" type="date" @input="markReceiptReviewDirty(false, 'date')" /><small v-if="receiptFieldWarnings.date" class="receipt-field-warning">{{ receiptFieldWarnings.date }}</small></label>
              <label>Total<div class="receipt-total-field"><input v-model="receiptForm.amount" inputmode="decimal" placeholder="Enter total" @input="markReceiptReviewDirty(true, 'total')" /><select v-model="receiptForm.currency" aria-label="Receipt currency" @change="markReceiptReviewDirty(true, 'currency')"><option>EUR</option><option>USD</option></select></div><small v-if="receiptFieldWarnings.total || receiptFieldWarnings.currency" class="receipt-field-warning">{{ receiptFieldWarnings.total || receiptFieldWarnings.currency }}</small></label>
              <label>Category<select v-model="receiptForm.category" @change="markReceiptReviewDirty()"><option value="">Choose category</option><option v-for="category in categories" :key="category.id" :value="category.name">{{ category.name }}</option></select></label>
            </div>

            <div v-if="receiptReconciliation" class="receipt-reconciliation" :class="{ matched: !receiptReviewDirty && receiptReconciliation.matched === true, mismatch: !receiptReviewDirty && receiptReconciliation.matched === false, pending: receiptReviewDirty || receiptReconciliation.matched === null }" role="status" aria-live="polite">
              <strong v-if="receiptReviewDirty">Changes need a fresh check</strong>
              <strong v-else-if="receiptReconciliation.matched === true">Items match the receipt total</strong>
              <strong v-else-if="receiptReconciliation.matched === false">The totals do not match yet</strong>
              <strong v-else>Receipt totals need review</strong>
              <span v-if="receiptReviewDirty">We’ll check the exact amounts when you save. Nothing will be adjusted automatically.</span>
              <span v-else-if="receiptReconciliation.matched === false">Items {{ formatReceiptMoney(receiptReconciliation.itemTotal) }} · receipt {{ formatReceiptMoney(receiptReconciliation.total) }}. Edit the amounts or choose to save without item details.</span>
              <span v-else-if="receiptReconciliation.matched === true">Items {{ formatReceiptMoney(receiptReconciliation.itemTotal) }} · receipt {{ formatReceiptMoney(receiptReconciliation.total) }}</span>
              <span v-else>Check the missing amounts, or choose to save without item details.</span>
            </div>
            <p v-if="receiptReconciliation?.adjustmentTotal && receiptReconciliation.adjustmentTotal !== '0'" class="receipt-adjustment-summary">
              Discounts and adjustments <strong>{{ formatReceiptMoney(receiptReconciliation.adjustmentTotal) }}</strong> are included in the reconciliation.
            </p>
            <ul v-if="receiptReconciliation?.matched !== true && !receiptReviewDirty && !receiptTotalOnly && receiptReconciliation?.warnings.length" class="receipt-inline-warnings" role="alert">
              <li v-for="warning in receiptReconciliation.warnings.slice(0, 3)" :key="warning">{{ warning }}</li>
            </ul>
            <div v-if="!receiptReconciliation" class="receipt-reconciliation pending" role="status"><strong>Check receipt totals</strong><span>Compare the receipt total with the purchased items before saving.</span></div>
            <p v-if="receiptReconciliation?.articleCountMismatch || receiptReconciliation?.incompleteLineCount" class="receipt-review-warning" role="alert">
              <template v-if="receiptReconciliation?.reportedArticleCount !== null">The receipt reports {{ receiptReconciliation?.reportedArticleCount }} articles; {{ receiptReconciliation?.extractedLineCount }} line entries were extracted.</template>
              <template v-if="receiptReconciliation?.incompleteLineCount"> {{ receiptReconciliation.incompleteLineCount }} extracted line(s) are missing required details.</template>
              Check the receipt image and include every purchased line before confirming item details.
            </p>
            <div v-if="receiptId && !receiptHasBeenReviewed" class="receipt-reextract-consent">
              <label><input v-model="receiptRetryConsent" type="checkbox" :disabled="receiptBusy" /> I consent to send this saved receipt image to the configured cloud provider again.</label>
              <button class="expense-button expense-button--quiet" type="button" :disabled="receiptBusy || !receiptRetryConsent" @click="reextractReceipt">{{ receiptBusy ? 'Retrying with AI…' : 'Retry with AI' }}</button>
            </div>
            <p v-if="receiptSaveError" class="receipt-error" role="alert">{{ receiptSaveError }}</p>
            <p v-else-if="error" class="receipt-error" role="alert">{{ error }}</p>

            <details v-if="receiptImageUrl" class="receipt-optional-panel">
              <summary>Preview receipt</summary>
              <div class="receipt-image-frame"><img :src="receiptImageUrl" alt="Private receipt image for review" /></div>
            </details>

            <section class="receipt-items" aria-label="Receipt items">
              <div class="receipt-items-heading"><h3>Purchased items <span>({{ receiptTotalOnly ? 0 : receiptItems.length }})</span></h3><button class="receipt-text-button" type="button" :disabled="receiptTotalOnly" @click="markReceiptReviewDirty(true); receiptItems.push({ description: '', normalizedDescription: '', suggestedCategory: '', confidence: null, uncertainty: null, quantity: '', unit: '', packaging: '', unitPrice: '', discount: '', tax: '', taxIncluded: '', lineTotal: '', currency: receiptForm.currency, categoryId: null, sourceReceiptId: receiptId || null, extractionProvenance: null })">Add item</button></div>
              <div v-if="receiptTotalOnly" class="receipt-empty-items">This expense will keep its total without claiming item details.</div>
              <div v-else-if="receiptItems.length" class="receipt-item-list">
                <details v-for="(item, index) in receiptItems" :key="index" class="receipt-item">
                  <summary>
                    <span class="receipt-item-main"><strong>{{ item.description || `Item ${index + 1}` }}</strong><small>{{ item.quantity || '—' }} {{ item.unit }}</small></span>
                    <span class="receipt-item-trailing"><strong>{{ formatReceiptMoney(item.lineTotal) }}</strong><small v-if="item.uncertainty" class="receipt-field-warning">Check item</small></span>
                  </summary>
                  <div class="receipt-item-editor">
                    <label>Description<input v-model="item.description" maxlength="240" @input="markReceiptReviewDirty()" /></label>
                    <label>Quantity<input v-model="item.quantity" inputmode="decimal" @input="markReceiptReviewDirty(true)" /></label>
                    <label>Final price<input v-model="item.lineTotal" inputmode="decimal" @input="markReceiptReviewDirty(true)" /></label>
                    <small class="receipt-item-help">The final price must agree with the quantity, unit price, tax and discount in item details.</small>
                    <small v-if="item.uncertainty" class="receipt-item-uncertainty">{{ item.uncertainty }}</small>
                    <details class="receipt-advanced">
                      <summary>More item details</summary>
                      <label>Unit<input v-model="item.unit" maxlength="40" placeholder="each, kg…" @input="markReceiptReviewDirty(true)" /></label>
                      <label>Unit price<input v-model="item.unitPrice" inputmode="decimal" @input="markReceiptReviewDirty(true)" /></label>
                      <label>Discount<input v-model="item.discount" inputmode="decimal" @input="markReceiptReviewDirty(true)" /></label>
                      <label>Tax<input v-model="item.tax" inputmode="decimal" @input="markReceiptReviewDirty(true)" /></label>
                      <label>Tax included?<select v-model="item.taxIncluded" @change="markReceiptReviewDirty(true)"><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></select></label>
                      <label>Packaging<input v-model="item.packaging" maxlength="160" @input="markReceiptReviewDirty()" /></label>
                      <label>Normalized description<input v-model="item.normalizedDescription" maxlength="240" @input="markReceiptReviewDirty()" /></label>
                      <label>Item category<select v-model="item.categoryId" @change="markReceiptReviewDirty()"><option :value="null">No category</option><option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option></select></label>
                      <small v-if="item.suggestedCategory">Suggested category: {{ item.suggestedCategory }}</small>
                      <button class="receipt-text-button receipt-remove-item" type="button" @click="markReceiptReviewDirty(true); receiptItems.splice(index, 1)">Remove item</button>
                    </details>
                  </div>
                </details>
              </div>
              <div v-else class="receipt-empty-items">No items were extracted. Add items, or choose to save without item details.</div>
              <label class="receipt-total-only"><input v-model="receiptTotalOnly" type="checkbox" @change="markReceiptReviewDirty(true)" /> Save without item details</label>
            </section>

            <details v-if="receiptAdjustments.length || receiptSourceText || receiptWarnings.length || receiptForm.description || receiptDocumentEntries.length || receiptExtractionDiagnostics" class="receipt-optional-panel">
              <summary>Receipt technical details</summary>
              <div class="receipt-advanced-content">
                <label>Description<input v-model="receiptForm.description" maxlength="500" placeholder="Optional expense note" @input="markReceiptReviewDirty()" /></label>
                <section v-if="receiptAdjustments.length" class="receipt-adjustments" aria-label="Receipt adjustments">
                  <h3>Taxes and adjustments</h3><p>Keep these values as printed. Mark whether each is already included in the item lines.</p>
                  <div v-for="(adjustment, index) in receiptAdjustments" :key="index" class="receipt-adjustment-row">
                    <label>Label<input v-model="adjustment.label" maxlength="160" @input="markReceiptReviewDirty()" /></label>
                    <label>Type<select v-model="adjustment.kind" @change="markReceiptReviewDirty(true)"><option value="tax">Tax / VAT</option><option value="discount">Discount</option><option value="deposit">Deposit</option><option value="return">Return</option><option value="rounding">Rounding</option><option value="other">Other</option></select></label>
                    <label>Amount<input v-model="adjustment.amount" inputmode="decimal" placeholder="Unknown" @input="markReceiptReviewDirty(true)" /></label>
                    <label>Signed effect on total<input v-model="adjustment.signedAmount" inputmode="decimal" placeholder="e.g. -2.56" @input="markReceiptReviewDirty(true)" /></label>
                    <label>Included in total?<select v-model="adjustment.includedInTotal" @change="markReceiptReviewDirty(true)"><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></select></label>
                    <label>Already in item price?<select v-model="adjustment.includedInLineTotal" @change="markReceiptReviewDirty(true)"><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></select></label>
                  </div>
                </section>
                <section v-if="receiptDocumentEntries.length" class="receipt-document-entries" aria-label="All extracted receipt rows">
                  <h3>Printed rows preserved</h3>
                  <ul><li v-for="(entry, index) in receiptDocumentEntries" :key="index"><span>{{ entry.kind.value }} · {{ entry.description.value || 'Unlabeled row' }}</span><strong>{{ entry.signedAmount.value ?? entry.amount.value ?? '—' }} {{ receiptForm.currency }}</strong></li></ul>
                </section>
                <section v-if="receiptItems.some((item) => item.confidence !== null || item.uncertainty)" class="receipt-document-entries" aria-label="Extraction confidence details">
                  <h3>Item extraction confidence</h3>
                  <ul><li v-for="(item, index) in receiptItems" :key="index"><span>{{ item.description || `Item ${index + 1}` }}<template v-if="item.uncertainty"> · {{ item.uncertainty }}</template></span><strong>{{ item.confidence === null ? 'Not reported' : `${Math.round(item.confidence * 100)}%` }}</strong></li></ul>
                </section>
                <ul v-if="receiptWarnings.length" class="receipt-warning-list"><li v-for="warning in receiptWarnings" :key="warning">{{ warning }}</li></ul>
                <p v-if="receiptExtractionDiagnostics" class="receipt-diagnostics">Extraction check: provider status {{ receiptExtractionDiagnostics.responseStatus }}; {{ receiptExtractionDiagnostics.modelItemCount }} returned, {{ receiptExtractionDiagnostics.validatedItemCount }} validated, {{ receiptExtractionDiagnostics.persistedExtractionItemCount }} retained in extraction, {{ receiptExtractionDiagnostics.completeDraftItemCount }} complete draft lines, {{ receiptExtractionDiagnostics.incompleteExtractionItemCount }} extracted lines lack required details, {{ receiptExtractionDiagnostics.completeButUnmappedItemCount }} complete lines could not be normalized.</p>
                <details v-if="receiptSourceText" class="receipt-source-text"><summary>Text read from receipt</summary><pre>{{ receiptSourceText }}</pre></details>
              </div>
            </details>

            <details v-if="receiptPossibleMatches.length" class="receipt-optional-panel receipt-matches">
              <summary>Possible matching expenses ({{ receiptPossibleMatches.length }})</summary>
              <p>If this receipt is for an expense you already recorded, attach it instead of saving a duplicate.</p>
              <button v-for="match in receiptPossibleMatches" :key="match.id" class="expense-button expense-button--quiet" type="button" :disabled="receiptBusy" @click="attachReceiptMatch(match)">{{ humanDate(match.date) }} · {{ formatNative(match) }} · {{ match.description }}</button>
            </details>

          </div>
        </div>
        <div v-if="receiptDraftId" class="receipt-action-bar">
          <button class="expense-button expense-button--quiet" type="button" :disabled="receiptBusy" @click="rejectReceiptDraft">Discard draft</button>
          <button class="expense-button expense-button--primary" type="button" :disabled="receiptBusy || (!receiptReviewDirty && receiptReconciliation?.matched !== true && !receiptTotalOnly)" @click="confirmReceiptDraft">{{ receiptBusy ? 'Saving…' : 'Save expense' }}</button>
        </div>
      </section>
    </div>

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
.receipt-modal {
  display: flex;
  flex-direction: column;
  max-height: min(88dvh, 820px);
  max-width: 720px;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  width: min(720px, calc(100vw - 32px));
}
:global(html:has(.receipt-modal)), :global(body:has(.receipt-modal)) { overflow: hidden; }
.receipt-modal .expense-modal-heading { flex: 0 0 auto; margin: 0; padding: 20px 22px 12px; }
.receipt-modal-content { flex: 1 1 auto; min-height: 0; min-width: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 0 22px 18px; }
.receipt-consent { display: grid; gap: 16px; }
.receipt-consent > p { color: var(--muted); font-size: 13px; line-height: 1.55; margin: 0; }
.receipt-consent label, .receipt-total-only { align-items: center; display: flex; gap: 10px; font-size: 13px; }
.receipt-review { display: grid; gap: 14px; min-width: 0; }
.receipt-notice, .receipt-error { border: 1px solid var(--line); border-radius: 10px; font-size: 12px; line-height: 1.45; margin: 0; padding: 10px 12px; }
.receipt-notice { background: color-mix(in srgb, var(--eg-blue-soft) 18%, transparent); }
.receipt-error { background: var(--eg-danger-soft); border-color: var(--eg-danger); color: var(--eg-danger); }
.receipt-review-fields { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); min-width: 0; }
.receipt-review-fields > label, .receipt-item-editor > label, .receipt-advanced-content > label { color: var(--ink); display: grid; font-size: 12px; font-weight: 700; gap: 6px; min-width: 0; }
.receipt-review-fields input, .receipt-review-fields select, .receipt-item-editor input, .receipt-item-editor select, .receipt-advanced-content input, .receipt-adjustment-row input, .receipt-adjustment-row select {
  background: var(--surface, #fff);
  border: 1px solid var(--line);
  border-radius: 9px;
  box-sizing: border-box;
  color: var(--ink);
  font: inherit;
  min-height: 42px;
  min-width: 0;
  padding: 8px 10px;
  width: 100%;
}
.receipt-review-fields .receipt-primary-field { grid-column: 1 / -1; }
.receipt-total-field { display: grid; gap: 7px; grid-template-columns: minmax(0, 1fr) 86px; min-width: 0; }
.receipt-field-warning { color: var(--eg-warning); font-size: 11px; font-weight: 600; line-height: 1.35; }
.receipt-reconciliation { border: 1px solid var(--line); border-radius: 10px; display: grid; gap: 4px; padding: 11px 12px; font-size: 12px; }
.receipt-reconciliation span { color: var(--muted); line-height: 1.4; }
.receipt-reconciliation.matched { background: var(--eg-success-soft); border-color: var(--eg-success); }
.receipt-reconciliation.mismatch { background: var(--eg-danger-soft); border-color: var(--eg-danger); color: var(--eg-danger); }
.receipt-reconciliation.pending { background: var(--eg-warning-soft); border-color: var(--eg-warning); }
.receipt-adjustment-summary { align-items: baseline; color: var(--muted); display: flex; flex-wrap: wrap; font-size: 12px; gap: 5px; margin: -6px 0 0; }
.receipt-adjustment-summary strong { color: var(--ink); }
.receipt-inline-warnings { background: var(--eg-warning-soft); border-radius: 9px; color: var(--ink); display: grid; font-size: 12px; gap: 5px; line-height: 1.45; margin: -5px 0 0; padding: 10px 12px 10px 28px; }
.receipt-review-warning { background: var(--eg-warning-soft); border: 1px solid var(--eg-warning); border-radius: 9px; color: var(--ink); font-size: 12px; line-height: 1.45; margin: 0; padding: 10px 12px; }
.receipt-reextract-consent { align-items: center; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px 16px; justify-content: space-between; padding-bottom: 10px; }
.receipt-reextract-consent label { align-items: center; color: var(--muted); display: flex; flex: 1 1 280px; font-size: 12px; gap: 8px; line-height: 1.4; }
.receipt-reextract-consent .expense-button:disabled { border-style: dashed; opacity: .68; }
.receipt-diagnostics { color: var(--muted); font-size: 11px; line-height: 1.45; margin: 0; }
.receipt-optional-panel, .receipt-item { border: 1px solid var(--line); border-radius: 10px; min-width: 0; }
.receipt-optional-panel > summary { cursor: pointer; font-size: 12px; font-weight: 700; list-style-position: inside; padding: 11px 12px; }
.receipt-image-frame { align-items: center; background: #101923; border-top: 1px solid var(--line); display: flex; justify-content: center; max-height: 48vh; min-height: 120px; overflow: hidden; padding: 10px; }
.receipt-image-frame img { display: block; max-height: 44vh; max-width: 100%; object-fit: contain; }
.receipt-items { border-top: 1px solid var(--line); display: grid; gap: 10px; min-width: 0; padding-top: 13px; }
.receipt-items-heading { align-items: center; display: flex; gap: 12px; justify-content: space-between; }
.receipt-items-heading h3, .receipt-adjustments h3 { font-size: 14px; margin: 0; }
.receipt-items-heading h3 span { color: var(--muted); font-size: 12px; font-weight: 500; }
.receipt-text-button { background: transparent; border: 0; color: var(--eg-blue); cursor: pointer; font-size: 12px; font-weight: 700; padding: 6px 2px; }
.receipt-text-button:disabled { cursor: not-allowed; opacity: .5; }
.receipt-item-list { display: grid; gap: 7px; min-width: 0; }
.receipt-item { overflow: hidden; }
.receipt-item > summary { align-items: center; cursor: pointer; display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) auto; list-style-position: inside; min-width: 0; padding: 11px 12px; }
.receipt-item-main, .receipt-item-trailing { display: grid; gap: 3px; min-width: 0; }
.receipt-item-main strong { overflow-wrap: anywhere; }
.receipt-item-main small, .receipt-item-trailing small { color: var(--muted); font-size: 11px; }
.receipt-item-trailing { justify-items: end; text-align: right; }
.receipt-item-editor { border-top: 1px solid var(--line); display: grid; gap: 10px; grid-template-columns: repeat(3, minmax(0, 1fr)); min-width: 0; padding: 12px; }
.receipt-item-uncertainty { color: var(--eg-warning); font-size: 11px; grid-column: 1 / -1; line-height: 1.4; }
.receipt-item-help { color: var(--muted); font-size: 10px; grid-column: 1 / -1; line-height: 1.35; }
.receipt-advanced { align-self: start; grid-column: 1 / -1; min-width: 0; }
.receipt-advanced > summary { cursor: pointer; font-size: 11px; font-weight: 700; padding: 6px 0; }
.receipt-advanced > label { display: grid; font-size: 11px; font-weight: 700; gap: 5px; margin-top: 8px; }
.receipt-advanced > small { color: var(--muted); display: block; font-size: 11px; margin-top: 7px; }
.receipt-remove-item { color: var(--eg-danger); }
.receipt-empty-items { background: color-mix(in srgb, var(--surface) 86%, var(--line)); border-radius: 9px; color: var(--muted); font-size: 12px; line-height: 1.4; padding: 12px; }
.receipt-total-only { color: var(--muted); font-size: 12px; margin-top: 3px; }
.receipt-total-only input { accent-color: var(--eg-blue); min-height: auto; width: auto; }
.receipt-advanced-content { display: grid; gap: 12px; padding: 0 12px 12px; }
.receipt-adjustments { border-top: 1px solid var(--line); display: grid; gap: 10px; padding-top: 12px; }
.receipt-adjustments h3 { font-size: 13px; }
.receipt-adjustments > p, .receipt-matches > p { color: var(--muted); font-size: 11px; line-height: 1.4; margin: 0; }
.receipt-adjustment-row { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.receipt-adjustment-row label { display: grid; font-size: 11px; font-weight: 700; gap: 5px; min-width: 0; }
.receipt-document-entries { border-top: 1px solid var(--line); display: grid; gap: 8px; padding-top: 12px; }
.receipt-document-entries h3 { font-size: 13px; margin: 0; }
.receipt-document-entries ul { display: grid; gap: 6px; list-style: none; margin: 0; padding: 0; }
.receipt-document-entries li { align-items: baseline; color: var(--muted); display: flex; font-size: 11px; gap: 12px; justify-content: space-between; min-width: 0; }
.receipt-document-entries li span { min-width: 0; overflow-wrap: anywhere; }
.receipt-document-entries li strong { color: var(--ink); flex: 0 0 auto; }
.receipt-warning-list { color: var(--muted); font-size: 11px; line-height: 1.4; margin: 0; padding-left: 18px; }
.receipt-source-text { border-top: 1px solid var(--line); padding-top: 10px; }
.receipt-source-text > summary { cursor: pointer; font-size: 11px; font-weight: 700; }
.receipt-source-text pre { overflow-wrap: anywhere; white-space: pre-wrap; }
.receipt-matches { border: 1px solid var(--line); }
.receipt-matches > p { padding: 0 12px 10px; }
.receipt-matches button { justify-self: start; margin: 0 12px 8px; max-width: calc(100% - 24px); overflow-wrap: anywhere; white-space: normal; }
.receipt-action-bar { align-items: center; background: var(--surface, #fff); border-top: 1px solid var(--line); display: flex; flex: 0 0 auto; gap: 10px; justify-content: space-between; margin: 0; padding: 12px 22px max(12px, env(safe-area-inset-bottom)); z-index: 2; }
.receipt-action-bar .expense-button--primary { min-width: 150px; }
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
  .receipt-modal { max-height: min(92dvh, 820px); }
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
  .expense-modal-backdrop:has(.receipt-modal) { align-items: stretch; padding: 0; }
  .receipt-modal { border-radius: 0; height: 100dvh; max-height: 100dvh; max-width: none; width: 100vw; }
  .receipt-modal .expense-modal-heading { padding: 15px 16px 11px; }
  .receipt-modal-content { padding: 0 16px 14px; }
  .receipt-review-fields { grid-template-columns: minmax(0, 1fr); }
  .receipt-review-fields .receipt-primary-field { grid-column: auto; }
  .receipt-item-editor { grid-template-columns: minmax(0, 1fr); }
  .receipt-item-uncertainty, .receipt-advanced { grid-column: auto; }
  .receipt-adjustment-row { grid-template-columns: minmax(0, 1fr); }
  .receipt-action-bar { padding: 12px 16px max(12px, env(safe-area-inset-bottom)); }
  .receipt-action-bar .expense-button--primary { flex: 1; min-width: 0; }
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
