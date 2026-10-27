export interface PersonalExpense {
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
  createdAt: string;
  updatedAt: string;
  legacyRecordId?: string;
  legacyCreatedAt?: string;
  legacyUpdatedAt?: string;
}

export interface ExpenseInput {
  date?: unknown;
  amount?: unknown;
  currency?: unknown;
  amountEur?: unknown;
  fxRate?: unknown;
  category?: unknown;
  description?: unknown;
  tags?: unknown;
  liters?: unknown;
  _id?: unknown;
  legacyRecordId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ExpenseImportPreview {
  records: Omit<PersonalExpense, 'id' | 'createdAt' | 'updatedAt'>[];
  total: number;
  valid: number;
  duplicates: number;
  errors: string[];
}

export const BGN_PER_EUR = 1.95583;
