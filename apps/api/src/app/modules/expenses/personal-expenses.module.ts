import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { PersonalExpensesController } from './personal-expenses.controller';
import { PersonalFinanceController } from './personal-finance.controller';
import { PersonalExpenseStore } from './personal-expense.store';
import { PersonalExpenseCaptureService } from './personal-expense-capture.service';
import { PersonalFinanceApplication } from './application/personal-finance.application';
import { ReceiptIntelligenceApplication } from './application/receipt-intelligence.application';
import { PERSONAL_FINANCE_REPOSITORY, type PersonalFinanceRepository } from './application/ports/personal-finance.repository';
import { EXPENSE_TEXT_EXTRACTION, type ExpenseTextExtractionPort } from './application/ports/expense-extraction.port';
import { DOCUMENT_UNDERSTANDING, type DocumentUnderstandingPort } from './application/ports/document-understanding.port';
import { PRIVATE_RECEIPT_STORAGE, type PrivateReceiptStoragePort } from './application/ports/private-receipt-storage.port';
import { PostgresPersonalFinanceRepository, PERSONAL_FINANCE_POOL } from './infrastructure/postgres/postgres-personal-finance.repository';
import { LocalExpenseTextExtractor } from './infrastructure/local-expense-text-extractor';
import { OpenAiDocumentUnderstandingAdapter } from './infrastructure/openai-document-understanding.adapter';
import { LocalDocumentUnderstandingAdapter } from './infrastructure/local-document-understanding.adapter';
import { PaddleOcrAdapter } from './infrastructure/paddle-ocr.adapter';
import { GatewayReceiptInterpreterAdapter } from './infrastructure/gateway-receipt-interpreter.adapter';
import { LocalPrivateReceiptStorageAdapter } from './infrastructure/local-private-receipt-storage.adapter';
import {
  LlmGatewayService,
  OpenAiDeviceLlmProvider,
} from '../llm/llm-gateway.service';

function createPersonalFinancePool(): Pool {
  const connectionString = process.env.AUTH_DATABASE_URL?.trim();
  if (connectionString) {
    if (process.env.NODE_ENV === 'production') throw new Error('AUTH_DATABASE_URL is for isolated local development only; use configured PostgreSQL settings in production');
    let parsed: URL;
    try { parsed = new URL(connectionString); } catch { throw new Error('AUTH_DATABASE_URL must be a PostgreSQL connection URL'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('AUTH_DATABASE_URL is only supported for loopback development');
    const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 10000, application_name: 'energrid-personal-finance' });
    pool.on('error', () => undefined);
    return pool;
  }
  const { PGHOST: host, PGPORT: port, PGDATABASE: database, PGUSER: user, PGPASSWORD: password, PGSSL } = process.env;
  if (!host || !port || !database || !user || !password) throw new Error('Personal finance requires PostgreSQL configuration (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD)');
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('Invalid PostgreSQL port');
  const pool = new Pool({ host, port: portNumber, database, user, password, ssl: PGSSL?.toLowerCase() === 'true', max: 3, connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 10000, application_name: 'energrid-personal-finance' });
  pool.on('error', () => undefined);
  return pool;
}

@Module({
  controllers: [PersonalExpensesController, PersonalFinanceController],
  providers: [
    { provide: PERSONAL_FINANCE_POOL, useFactory: createPersonalFinancePool },
    { provide: PERSONAL_FINANCE_REPOSITORY, inject: [PERSONAL_FINANCE_POOL], useFactory: (pool: Pool) => new PostgresPersonalFinanceRepository(pool) },
    { provide: EXPENSE_TEXT_EXTRACTION, useFactory: () => new LocalExpenseTextExtractor() },
    {
      provide: DOCUMENT_UNDERSTANDING,
      inject: [LlmGatewayService],
      useFactory: (gateway: LlmGatewayService): DocumentUnderstandingPort => {
        const provider = process.env.PERSONAL_FINANCE_RECEIPT_PROVIDER?.trim() || 'openai-vision';
        if (provider === 'openai-vision') return new OpenAiDocumentUnderstandingAdapter();
        if (provider === 'paddleocr-text') return new LocalDocumentUnderstandingAdapter(new PaddleOcrAdapter(), new GatewayReceiptInterpreterAdapter(gateway));
        throw new Error('PERSONAL_FINANCE_RECEIPT_PROVIDER must be openai-vision or paddleocr-text');
      },
    },
    { provide: PRIVATE_RECEIPT_STORAGE, useFactory: () => new LocalPrivateReceiptStorageAdapter() },
    {
      provide: PersonalFinanceApplication,
      inject: [PERSONAL_FINANCE_REPOSITORY, EXPENSE_TEXT_EXTRACTION],
      useFactory: (repository: PersonalFinanceRepository, extraction: ExpenseTextExtractionPort) => new PersonalFinanceApplication(repository, extraction),
    },
    {
      provide: ReceiptIntelligenceApplication,
      inject: [PERSONAL_FINANCE_REPOSITORY, DOCUMENT_UNDERSTANDING, PRIVATE_RECEIPT_STORAGE, PersonalFinanceApplication],
      useFactory: (repository: PersonalFinanceRepository, understanding: DocumentUnderstandingPort, storage: PrivateReceiptStoragePort, finance: PersonalFinanceApplication) => new ReceiptIntelligenceApplication(repository, understanding, storage, finance),
    },
    PersonalExpenseStore,
    PersonalExpenseCaptureService,
    OpenAiDeviceLlmProvider,
    {
      provide: LlmGatewayService,
      inject: [OpenAiDeviceLlmProvider],
      useFactory: (openai: OpenAiDeviceLlmProvider) => {
        const gateway = new LlmGatewayService();
        gateway.registerProvider(openai);
        return gateway;
      },
    },
  ],
  exports: [PersonalFinanceApplication],
})
export class PersonalExpensesModule implements OnModuleDestroy {
  constructor(@Inject(PERSONAL_FINANCE_POOL) private readonly pool: Pool) {}
  async onModuleDestroy(): Promise<void> { await this.pool.end(); }
}
