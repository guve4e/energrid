import { Injectable } from '@nestjs/common';
import type { EstimateConversationDraft } from './estimate-draft.types';

@Injectable()
export class EstimateQuestionService {
  async generateFollowupQuestion(input: { draft: EstimateConversationDraft; missingFields: string[] }): Promise<string> {
    return this.fallbackQuestion(input.missingFields[0] || 'jobType', input.draft);
  }

  fallbackQuestion(field: string, _draft?: EstimateConversationDraft): string {
    const questions: Record<string, string> = {
      quantity: 'Колко броя трябва да се монтират или изградят?',
      routeLengthMeters: 'Колко метра е трасето за всеки уред или точка? При различни трасета ги оценете отделно.',
      wallType: 'Трасето е без къртене, в тухла или в бетон?',
      powerSource: 'Има ли готово захранване или трябва нова линия от таблото?',
      connectionMode: 'Ще се използва съществуващ кабел или трябва нова линия? Ако не знаете, е нужен оглед.',
      panelKind: 'Какво табло е необходимо: бойлерно, стандартно с автомати, с ДТЗ групи, с пълна защита или по индивидуален проект? Ако не знаете, уточняваме на оглед.',
      jobType: 'Какво искате да направим: свързване на бойлер, печка или климатик, нови електрически точки или табло? За цял обект оценяваме дейностите поотделно.',
    };
    return questions[field] || questions.jobType;
  }
}
