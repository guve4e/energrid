import { Module } from '@nestjs/common';
import { PersonalExpensesController } from './personal-expenses.controller';
import { PersonalExpenseStore } from './personal-expense.store';
import { PersonalExpenseCaptureService } from './personal-expense-capture.service';
import {
  LlmGatewayService,
  OpenAiDeviceLlmProvider,
} from '../llm/llm-gateway.service';

@Module({
  controllers: [PersonalExpensesController],
  providers: [
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
})
export class PersonalExpensesModule {}
