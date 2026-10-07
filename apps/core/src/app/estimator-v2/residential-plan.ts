import type { EstimateConversationDraft } from './estimate-draft.types';

export interface ResidentialPlan {
  version: 'studio-circuits-v1';
  status: 'proposed' | 'accepted-for-estimation';
  circuits: Array<{ id: string; label: string; basis: 'template-assumption' | 'customer-confirmed-appliance' }>;
  assumptions: string[];
  missingForPricing: string[];
}

export function residentialPlan(draft: EstimateConversationDraft, previousDraft?: EstimateConversationDraft | null): {
  status: 'needs_input' | 'proposal' | 'needs_inspection'; reply: string; draft: EstimateConversationDraft; plan?: ResidentialPlan;
} {
  // Respond to the customer's question before resuming intake or returning a scope limit.
  if (draft.currentIntent === 'explain' || draft.currentIntent === 'question_why') return {
    status: 'needs_input', draft,
    reply: `Прави сте — трябваше да обясня по-рано. Питам за бойлера и климатиците, защото влияят върху захранващите линии и таблото${draft.acCount ? `; записах ${draft.acCount} климатика` : ''}. Това помага за обхвата на работата, но не е достатъчно за обща цена. В момента нямам надеждна калкулация за цялостна инсталация на такова жилище. Можем да уточним работата по помещения, без да е нужно веднага да уговаряме оглед.`,
  };
  if (draft.propertyType && draft.areaSqm && (draft.propertyType !== 'studio' || draft.areaSqm > 40)) return {
    status: 'needs_inspection', draft,
    reply: `За ${draft.areaSqm} кв. м мога да помогна да уточним обхвата, но още нямам надеждна калкулация за цялостна инсталация${draft.acCount ? `. Записах ${draft.acCount} климатика` : ''}. Не искам да ви разпитвам за уреди с обещание за сума, която не мога да изчисля. За ориентир по нашите цени ще трябват броят на точките и приблизителните трасета по помещения; можем да ги уточним по план.`,
  };
  const missing: Array<[keyof EstimateConversationDraft, string]> = [
    ['propertyType', 'Обектът гарсониера, апартамент или къща е?'],
    ['areaSqm', 'Колко квадратни метра е жилището?'],
    ['buildingStage', 'Ново строителство ли е, или подмяна на стара инсталация?'],
    ['hasBoiler', 'Предвиждате ли електрически бойлер?'],
    ['hasAc', 'Предвиждате ли климатик?'],
  ];
  for (const [field, question] of missing) {
    if (draft[field] == null) {
      const learnedAppliances = [
        draft.hasBoiler === true && previousDraft?.hasBoiler !== true ? 'бойлера' : '',
        draft.hasAc === true && previousDraft?.hasAc !== true ? 'климатика' : '',
      ].filter(Boolean);
      const acknowledgement = learnedAppliances.length ? `Добре, включвам и ${learnedAppliances.join(' и ')}. ` : '';
      return { status: 'needs_input', reply: acknowledgement + question, draft: { ...draft, currentQuestionField: field as EstimateConversationDraft['currentQuestionField'] } };
    }
  }
  const plan: ResidentialPlan = {
    version: 'studio-circuits-v1', status: draft.planAccepted ? 'accepted-for-estimation' : 'proposed',
    circuits: [
      { id: 'lighting', label: 'Осветление — отделно от контактите', basis: 'template-assumption' },
      { id: 'living-sockets', label: 'Контакти в дневната / спалната зона', basis: 'template-assumption' },
      { id: 'kitchen-sockets', label: 'Контакти за кухненския плот и обичайните малки уреди', basis: 'template-assumption' },
      ...(draft.hasCooker === false ? [] : [{ id: 'cooker', label: 'Печка / плот — предложен самостоятелен кръг', basis: draft.hasCooker ? 'customer-confirmed-appliance' as const : 'template-assumption' as const }]),
      ...(draft.hasWashingMachine === false ? [] : [{ id: 'washer', label: 'Пералня — предложен самостоятелен кръг', basis: draft.hasWashingMachine ? 'customer-confirmed-appliance' as const : 'template-assumption' as const }]),
      ...(draft.hasBoiler ? [{ id: 'boiler', label: 'Бойлер — предложен самостоятелен кръг', basis: 'customer-confirmed-appliance' as const }] : []),
      ...(draft.hasAc ? Array.from({ length: draft.acCount ?? 1 }, (_, i) => ({ id: i === 0 ? 'ac' : `ac-${i + 1}`, label: `Климатик${draft.acCount ? ` ${i + 1}` : ''} — предложен самостоятелен кръг`, basis: 'customer-confirmed-appliance' as const })) : []),
    ],
    assumptions: [
      'Начален шаблон на Energrid за обсъждане, не завършен електрически проект или удостоверена нормативна схема.',
      'Елементите с означение „предложение“ са допускания; потвърдете ги или посочете промени.',
      'Предлагаме индивидуална дефектнотокова и максималнотокова защита (RCBO) за бойлера. Конкретната защита се избира след проверка на захранването, уреда и приложимите изисквания.',
      'Броят кръгове не определя автоматично броя контакти, дължините на кабелите, сеченията или номиналите на защитите.',
    ],
    missingForPricing: ['Брой контакти, ключове и осветителни изводи по помещения', 'Приблизителни трасета и начин на полагане', 'Проверка на захранване, заземяване, товари и табло'],
  };
  if (!draft.hasBoiler) plan.assumptions = plan.assumptions.filter(item => !item.includes('RCBO'));
  const appliances = [draft.hasBoiler ? 'бойлера' : '', draft.hasAc ? 'климатика' : ''].filter(Boolean);
  let reply = `Разбрах — гарсониера ${draft.areaSqm} кв. м, ${draft.buildingStage === 'new' ? 'ново строителство' : 'ремонт'}. Бих отделил осветлението от контактите и бих предвидил отделно захранване за кухнята${appliances.length ? `, както и за ${appliances.join(' и ')}` : ''}. Това е начална идея, която уточняваме според жилището.`;
  if (draft.planAccepted) {
    reply = 'Добре, използваме това като отправна точка. За цената остават броят на контактите и осветителните изводи и дължините на трасетата. Тях трябва да уточним по план или при оглед, за да не ви дам подвеждаща сума.';
  } else if (draft.hasCooker == null && draft.hasWashingMachine == null) {
    reply += ' Предвиждате ли и печка и пералня?';
  } else if (draft.hasCooker == null) {
    reply += ' Ще има ли печка или плот?';
  } else if (draft.hasWashingMachine == null) {
    reply += ' Ще има ли пералня?';
  } else {
    reply += ' Подходящо ли ви се струва като начало?';
  }
  const currentQuestionField = draft.hasCooker == null && draft.hasWashingMachine == null ? 'kitchenAppliances' : draft.hasCooker == null ? 'hasCooker' : draft.hasWashingMachine == null ? 'hasWashingMachine' : 'planAccepted';
  return { status: 'proposal', reply, plan, draft: { ...draft, currentQuestionField } };
}
