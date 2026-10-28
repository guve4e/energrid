import type { ExpenseTextExtractionPort } from '../application/ports/expense-extraction.port';
import type { ExpenseDraftProposal } from '../domain/personal-finance.types';

/** Provider-independent, local-only baseline parser. It proposes data; it never persists it. */
export class LocalExpenseTextExtractor implements ExpenseTextExtractionPort {
  async extract(text: string): Promise<ExpenseDraftProposal> {
    const amountMatch = text.match(/(?:€|EUR|евро|евра|лв\.?|лева|лев)\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*(€|EUR|евро|евра|лв\.?|лева|лев)/iu);
    const amount = amountMatch ? (amountMatch[1] ?? amountMatch[2]).replace(',', '.') : null;
    const currencyLabel = amountMatch?.[3] ?? (amountMatch?.[0].match(/^(?:€|EUR|евро|евра|лв\.?|лева|лев)/iu)?.[0] ?? null);
    const currency = currencyLabel
      ? (/^(?:лв\.?|лева|лев)$/iu.test(currencyLabel) ? 'BGN' : 'EUR')
      : null;

    const merchantMatch = text.match(/(?:\b(?:at|from|in)\b|(?<![\p{L}])(?:в|от))\s+([\p{L}\d][\p{L}\d &.'’’-]{0,80}?)(?=[.!?,;]|$)/iu);
    const spokenMerchant = merchantMatch?.[1]?.trim().replace(/[.!?,;]+$/, '') || null;
    const merchantName = normalizeMerchantAlias(spokenMerchant);
    const lowered = text.toLocaleLowerCase();
    const category = /grocer|lidl|kaufland|supermarket|food shop|хранител|\bхрана\b|\bхрани\b/.test(lowered) || merchantName === 'Lidl' || merchantName === 'Kaufland' ? 'Groceries'
      : /fuel|petrol|gas station|бензин|горив/.test(lowered) ? 'Fuel'
        : /кучет|кучеш|домашн(?:и|и любимци)|\bpet\b|\bpets\b/.test(lowered) ? 'Pets' : null;
    return {
      date: new Date().toISOString().slice(0, 10),
      amount,
      currency,
      merchantName,
      category,
      // Keep what the user said intact; normalized merchant data is a separate field.
      description: text.trim().slice(0, 500),
      tags: [], items: [], receipts: [], sourceKind: 'assistant-text', sourceId: null,
      extractionProvider: 'local-regex', extractionModel: null,
    };
  }
}

function normalizeMerchantAlias(merchant: string | null): string | null {
  if (!merchant) return null;
  const key = merchant.toLocaleLowerCase().replace(/[.\s]+$/u, '');
  if (/^(?:магазин(?:а|ът)?|супермаркет(?:а|ът)?|store|shop|supermarket)$/u.test(key)) return null;
  if (/^(?:lidl|лидл)$/u.test(key)) return 'Lidl';
  if (/^(?:kaufland|кауфланд)$/u.test(key)) return 'Kaufland';
  return merchant;
}
