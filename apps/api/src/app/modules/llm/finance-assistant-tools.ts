import { Injectable } from '@nestjs/common';
import type { AnyAgentTool } from '@letta-ai/letta-agent-sdk';
import type { AuthPrincipal } from '../auth/auth.types';
import { randomUUID } from 'node:crypto';
import { PersonalFinanceApplication } from '../expenses/application/personal-finance.application';
import type { ExpenseQuery } from '../expenses/domain/personal-finance.types';

const DRAFT_TTL_MS = 15 * 60 * 1000;

type DraftState = {
  accountId: string;
  draftId: string;
  expiresAt: number;
  status: 'proposed' | 'confirmed' | 'rejected';
};

export interface FinanceToolContext {
  principal?: AuthPrincipal;
  conversationId: string;
  userMessage: string;
}

/** Validates Letta arguments and delegates all finance work to V2 application operations. */
@Injectable()
export class FinanceAssistantTools {
  private readonly draftsByConversation = new Map<string, DraftState>();

  constructor(private readonly finance: PersonalFinanceApplication) {}

  tools(context: FinanceToolContext): AnyAgentTool[] {
    const args = (raw: unknown, allowed: string[]) => exactObject(raw, allowed);
    return [
      {
        name: 'finance.propose_expense',
        label: 'Propose an expense draft',
        description: 'Create a reviewable expense draft from the user’s current message. This does not confirm or save a finance expense. Call only when the user described a purchase. The original user message is used as extraction input; do not provide rewritten values.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async (toolCallId, raw) => {
          if (!this.hasPrincipal(context.principal)) return error('A verified signed-in account is required for finance tools.');
          if (!args(raw, [])) return error('This tool takes no arguments.');
          const accountId = context.principal.userId;
          const key = this.stateKey(context.conversationId, accountId);
          const existing = this.liveDraft(key, accountId);
          if (existing?.status === 'proposed') return error('There is already a pending expense draft in this conversation. Ask the user to confirm or reject it first.');
          try {
            const draft = await this.finance.proposeExpenseDraft({
              accountId,
              text: context.userMessage,
              cloudDataConsent: false,
              sourceId: `assistant-tool-call:${context.conversationId}:${toolCallId || randomUUID()}`,
            });
            this.draftsByConversation.set(key, {
              accountId,
              draftId: draft.id,
              expiresAt: Date.now() + DRAFT_TTL_MS,
              status: 'proposed',
            });
            return result(draftProjection(draft));
          } catch (cause) {
            return error(errorMessage(cause, 'Energrid could not prepare this expense draft.'));
          }
        },
      },
      {
        name: 'finance.get_draft',
        label: 'Get an expense draft',
        description: 'Read one draft owned by the signed-in user. Requires the draft ID returned by finance.propose_expense.',
        parameters: {
          type: 'object', properties: { draftId: { type: 'string', description: 'The exact draft ID returned by the proposal tool.' } },
          required: ['draftId'], additionalProperties: false,
        },
        execute: async (_id, raw) => {
          if (!this.hasPrincipal(context.principal)) return error('A verified signed-in account is required for finance tools.');
          if (!args(raw, ['draftId']) || !isIdentifier((raw as any).draftId)) return error('Provide a valid draftId.');
          const draft = await this.finance.getExpenseDraft(context.principal.userId, (raw as any).draftId);
          return draft ? result(draftProjection(draft)) : error('No expense draft with that ID is available to this account.');
        },
      },
      {
        name: 'finance.confirm_expense',
        label: 'Confirm a proposed expense',
        description: 'Confirm only after the current user message is an unambiguous affirmative response and draftId exactly matches the fresh draft proposed in this conversation. Never call this on the same turn that created the draft.',
        parameters: {
          type: 'object', properties: { draftId: { type: 'string', description: 'The exact pending draft ID.' } },
          required: ['draftId'], additionalProperties: false,
        },
        execute: async (_id, raw) => this.finishDraft(context, raw, 'confirm'),
      },
      {
        name: 'finance.reject_draft',
        label: 'Reject an expense draft',
        description: 'Reject only after the current user clearly asks to cancel or discard the exact pending draft in this conversation.',
        parameters: {
          type: 'object', properties: { draftId: { type: 'string', description: 'The exact pending draft ID.' } },
          required: ['draftId'], additionalProperties: false,
        },
        execute: async (_id, raw) => this.finishDraft(context, raw, 'reject'),
      },
      {
        name: 'finance.query_expenses',
        label: 'Query expenses',
        description: 'List matching confirmed expenses for the signed-in user. Use for requests such as latest expenses or finding transactions. This tool does not calculate totals; use finance.summarize_spending for amounts and comparisons.',
        parameters: {
          type: 'object', properties: {
            fromDate: { type: 'string', description: 'Inclusive YYYY-MM-DD lower bound.' },
            toDate: { type: 'string', description: 'Inclusive YYYY-MM-DD upper bound.' },
            period: { type: 'string', enum: ['this_month', 'last_month'], description: 'Use instead of date bounds for the current or previous calendar month in Energrid’s configured finance timezone.' },
            category: { type: 'string', description: 'Exact category filter.' },
            text: { type: 'string', description: 'Merchant or description search.' },
            limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum records; defaults to 10.' },
          }, additionalProperties: false,
        },
        execute: async (_id, raw) => {
          if (!this.hasPrincipal(context.principal)) return error('A verified signed-in account is required for finance tools.');
          if (!args(raw, ['fromDate', 'toDate', 'period', 'category', 'text', 'limit'])) return error('Expense query arguments are malformed.');
          const query = parseQuery(raw, true);
          if (!query) return error('Use valid date bounds, category/text strings, and a limit from 1 to 50.');
          try {
            const expenses = await this.finance.queryExpenses({ accountId: context.principal.userId, query });
            return result(expenses.map(expenseProjection));
          } catch (cause) { return error(errorMessage(cause, 'Energrid could not query expenses.')); }
        },
      },
      {
        name: 'finance.summarize_spending',
        label: 'Summarize spending',
        description: 'Get backend-calculated EUR totals, transaction counts, category, merchant and product breakdowns for the signed-in user. Use for how much, category comparisons, monthly totals, and trends. Never calculate or alter totals yourself.',
        parameters: {
          type: 'object', properties: {
            fromDate: { type: 'string', description: 'Inclusive YYYY-MM-DD lower bound.' },
            toDate: { type: 'string', description: 'Inclusive YYYY-MM-DD upper bound.' },
            period: { type: 'string', enum: ['this_month', 'last_month'], description: 'Use instead of date bounds for the current or previous calendar month in Energrid’s configured finance timezone.' },
          }, additionalProperties: false,
        },
        execute: async (_id, raw) => {
          if (!this.hasPrincipal(context.principal)) return error('A verified signed-in account is required for finance tools.');
          if (!args(raw, ['fromDate', 'toDate', 'period'])) return error('Summary arguments are malformed.');
          const query = parseQuery(raw, false);
          if (!query) return error('Use valid inclusive YYYY-MM-DD date bounds.');
          try {
            return result(await this.finance.summarizeSpending({ accountId: context.principal.userId, query }));
          } catch (cause) { return error(errorMessage(cause, 'Energrid could not summarize spending.')); }
        },
      },
    ];
  }

  private async finishDraft(context: FinanceToolContext, raw: unknown, action: 'confirm' | 'reject') {
    if (!this.hasPrincipal(context.principal)) return error('A verified signed-in account is required for finance tools.');
    if (!exactObject(raw, ['draftId']) || !isIdentifier((raw as any).draftId)) return error('Provide a valid draftId.');
    const accountId = context.principal.userId;
    const key = this.stateKey(context.conversationId, accountId);
    const draftState = this.liveDraft(key, accountId);
    const expectedPhrase = action === 'confirm' ? isUnambiguousConfirmation(context.userMessage) : isUnambiguousRejection(context.userMessage);
    const canRepeatConfirmed = action === 'confirm' && draftState?.status === 'confirmed';
    if (!draftState) {
      return error('There is no active expense draft in this conversation. Propose it again before updating it.');
    }
    if (draftState.status !== 'proposed' && !canRepeatConfirmed) return error('This expense draft is no longer pending.');
    if (draftState.draftId !== (raw as any).draftId) return error('The supplied draft ID does not match the active expense draft in this conversation.');
    if (!expectedPhrase) {
      return error(action === 'confirm'
        ? 'Confirmation needs a clear affirmative reply to the current pending draft in this conversation. Please review the proposal again.'
        : 'Rejection needs a clear request to cancel the current pending draft in this conversation.');
    }
    try {
      const changed = action === 'confirm'
        ? await this.finance.confirmExpense({ accountId, actorId: accountId, draftId: draftState.draftId })
        : await this.finance.rejectExpenseDraft({ accountId, actorId: accountId, draftId: draftState.draftId });
      if (!changed) return error('The pending expense draft is unavailable or has expired.');
      draftState.status = action === 'confirm' ? 'confirmed' : 'rejected';
      return result(action === 'confirm' ? expenseProjection(changed as any) : draftProjection(changed as any));
    } catch (cause) { return error(errorMessage(cause, 'Energrid could not update this expense draft.')); }
  }

  private liveDraft(key: string, accountId: string): DraftState | null {
    const state = this.draftsByConversation.get(key);
    if (!state) return null;
    if (state.accountId !== accountId || state.expiresAt <= Date.now()) {
      this.draftsByConversation.delete(key);
      return null;
    }
    return state;
  }

  private stateKey(conversationId: string, accountId: string) { return `${accountId}:${conversationId}`; }
  private hasPrincipal(principal?: AuthPrincipal): principal is AuthPrincipal {
    return !!principal && principal.role === 'admin' && typeof principal.userId === 'string' && principal.userId.trim().length > 0;
  }
}

function exactObject(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function parseQuery(raw: Record<string, unknown>, includeListFields: boolean): ExpenseQuery | null {
  const query: ExpenseQuery = {};
  if (raw.period !== undefined) {
    if (!['this_month', 'last_month'].includes(String(raw.period)) || raw.fromDate !== undefined || raw.toDate !== undefined) return null;
    Object.assign(query, monthBounds(raw.period as 'this_month' | 'last_month'));
  }
  for (const key of ['fromDate', 'toDate'] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || !validDate(value)) return null;
      query[key] = value;
    }
  }
  if (query.fromDate && query.toDate && query.fromDate > query.toDate) return null;
  if (includeListFields) {
    if (raw.category !== undefined) {
      if (typeof raw.category !== 'string' || !raw.category.trim() || raw.category.length > 80) return null;
      query.category = raw.category.trim();
    }
    if (raw.text !== undefined) {
      if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 160) return null;
      query.text = raw.text.trim();
    }
    if (raw.limit !== undefined) {
      if (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 50) return null;
      query.limit = raw.limit as number;
    } else query.limit = 10;
  }
  return query;
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function monthBounds(period: 'this_month' | 'last_month') {
  const timeZone = process.env.ENERGRID_FINANCE_TIME_ZONE || 'Europe/Sofia';
  const today = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const year = Number(today.year);
  const month = Number(today.month);
  const offset = period === 'this_month' ? 0 : -1;
  const start = new Date(Date.UTC(year, month - 1 + offset, 1));
  const end = new Date(Date.UTC(year, month + offset, 0));
  return { fromDate: start.toISOString().slice(0, 10), toDate: end.toISOString().slice(0, 10) };
}

function isUnambiguousConfirmation(text: string) {
  const normalized = normalizeConfirmationText(text);
  return /^(yes|yes please|yes save it|yes add it|yeah|yep|correct|confirm|confirm expense|save it|add it|go ahead|do it|да( запиши( го)?| запази( го)?| добави( го)?)?|потвърждавам|запиши( го)?|запази( го)?|добави( го)?)( it)?$/.test(normalized);
}

function isUnambiguousRejection(text: string) {
  const normalized = normalizeConfirmationText(text);
  return /^(no|no don't save|no do not save|nope|cancel|cancel it|reject|discard|discard it|do not save|don't save|не|откажи|отмени|отмени този разход|откажи черновата [a-z0-9_-]{1,64})$/.test(normalized);
}

function normalizeConfirmationText(text: string) {
  return text.normalize('NFKC').toLocaleLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function draftProjection(draft: any) {
  return {
    id: draft.id, status: draft.status, date: draft.date, amount: draft.amount,
    currency: draft.currency, merchantName: draft.merchantName, category: draft.category,
    description: draft.description, tags: draft.tags, items: draft.items,
    createdAt: draft.createdAt,
  };
}

function expenseProjection(expense: any) {
  return {
    id: expense.id, date: expense.date, amount: expense.amount, currency: expense.currency,
    amountEur: expense.amountEur, merchantName: expense.merchantName,
    categoryId: expense.categoryId ?? null, category: expense.category, description: expense.description, items: expense.items,
  };
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
}

function error(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message.slice(0, 240) : fallback;
}
