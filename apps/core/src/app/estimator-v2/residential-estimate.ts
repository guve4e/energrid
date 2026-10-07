import { ServiceUnavailableException } from '@nestjs/common';
import type { EstimateConversationDraft } from './estimate-draft.types';
import type { RangeEstimate } from './appliance-estimate';
import { RESIDENTIAL_TEMPLATE, proposedCircuits, lightingSpaces, type ResidentialTemplate } from './residential-template';

// Commercial starting assumptions, not statutory minima or an electrical design.
export const BASIC_HOME = RESIDENTIAL_TEMPLATE;
type CatalogRow = { code: string; base_price: number | string; unit: string; labor_included: boolean; materials_included: boolean };
export function estimateResidential(draft: EstimateConversationDraft, catalog: CatalogRow[], message = '', previousDraft?: EstimateConversationDraft | null, template: ResidentialTemplate = RESIDENTIAL_TEMPLATE) {
  const BASIC_HOME = template;
  if (!draft.roomCount && !draft.areaSqm && draft.propertyType !== 'studio') return {
    status: 'needs_input' as const, draft: { ...draft, currentQuestionField: 'areaSqm' as const },
    reply: 'Колко жилищни стаи има, без кухнята, банята и коридора? Не е нужно да знаете квадратурата — с броя стаи мога да дам начална сметка само за труд.',
  };
  const rooms = draft.roomCount ?? (draft.propertyType === 'studio' ? 1 : Math.max(1, Math.ceil(draft.areaSqm! / 40)));
  const separateKitchen = draft.separateKitchen ?? false;
  const spaces = lightingSpaces(draft, rooms, template);
  const sockets = draft.socketCount ?? rooms * BASIC_HOME.socketsPerRoom + BASIC_HOME.kitchenSockets + BASIC_HOME.corridorSockets * (draft.corridorCount ?? template.corridorCount) + BASIC_HOME.bathroomSockets * (draft.bathroomCount ?? template.bathroomCount);
  const lights = draft.lightingPointCount ?? spaces;
  const applianceCounts: Array<[string, number, boolean]> = [
    ['бойлер', Number(draft.hasBoiler ?? BASIC_HOME.boiler), draft.hasBoiler == null],
    ['климатици', draft.hasAc === false ? 0 : draft.acCount ?? (draft.hasAc ? 1 : rooms), draft.hasAc == null && draft.acCount == null],
    ['фурна', Number(draft.hasOven ?? draft.hasCooker ?? BASIC_HOME.oven), draft.hasOven == null && draft.hasCooker == null],
    ['плот', Number(draft.hasHob ?? draft.hasCooker ?? BASIC_HOME.hob), draft.hasHob == null && draft.hasCooker == null],
    ['пералня', Number(draft.hasWashingMachine ?? BASIC_HOME.washer), draft.hasWashingMachine == null],
    ['сушилня', Number(draft.hasDryer ?? BASIC_HOME.dryer), draft.hasDryer == null],
    ['съдомиялна', Number(draft.hasDishwasher ?? BASIC_HOME.dishwasher), draft.hasDishwasher == null],
  ];
  const appliances = applianceCounts.reduce((n, a) => n + a[1], 0);
  const points = sockets + lights + appliances;
  const lines: RangeEstimate['lines'] = [];
  function add(code: string, label: string, low: number, high = low) {
    if (!high) return;
    const row = catalog.find(r => r.code === code);
    const price = Number(row?.base_price);
    if (!row || !Number.isFinite(price) || price < 0 || !row.labor_included || row.materials_included) throw new ServiceUnavailableException(`Missing or incompatible labour rate: ${code}`);
    lines.push({ code, label, quantity: low, unit: row.unit, unitPriceMin: price, unitPriceMax: price, min: price * low, max: price * high });
  }
  add('power_point_up_to_3m', `Изводи: ${sockets} контакта, ${lights} осветителни, ${appliances} за уреди`, points);
  add('power_line_extra_meter_after_3m', `Допълнително трасе: 0–${points * (BASIC_HOME.routeMax - BASIC_HOME.routeMin)} м общо`, 0, points * (BASIC_HOME.routeMax - BASIC_HOME.routeMin));
  add('socket_or_switch_concealed', `Монтаж: ${sockets} контакта и ${lights} обикновени ключа`, sockets + lights);
  const panel = ['panel_modern', 'panel_full_protection', 'panel_custom'].includes(draft.panelKind ?? '') ? draft.panelKind! : template.defaultPanelCode;
  add(panel, 'Монтаж на табло — 1 бр.', 1);
  if (draft.smartRelayCount) add('smart_relay_single', `Умни релета: ${draft.smartRelayCount} бр., монтаж и конфигурация`, draft.smartRelayCount);
  if (draft.wallType === 'brick' || draft.wallType === 'concrete') add(`chasing_${draft.wallType}_per_meter`, `Къртене: допускане ${points * BASIC_HOME.routeMin}–${points * BASIC_HOME.routeMax} м`, points * BASIC_HOME.routeMin, points * BASIC_HOME.routeMax);
  const assumptions = [
    `Разпределение: ${rooms} ${rooms === 1 ? 'стая' : 'стаи'}, ${draft.corridorCount ?? template.corridorCount} коридор(а), ${draft.bathroomCount ?? template.bathroomCount} баня/бани, ${draft.terraceCount ?? template.terraceCount} тераса/тераси; кухнята е ${separateKitchen ? 'отделна' : 'в една от стаите (допускане, ако не е уточнено)'}.`,
    `${sockets} контактни точки (${draft.socketCount == null ? `допускане: ${template.socketsPerRoom} на стая + ${template.kitchenSockets} кухненски + ${template.corridorSockets} на коридор + ${template.bathroomSockets} на баня; местата се проверяват` : 'по ваши данни'}); ${lights} осветителни извода и ${lights} ключа.`,
    `Захранвания за: ${applianceCounts.filter(a => a[1]).map(([name, count, assumed]) => `${name} × ${count}${assumed ? ' (допускане)' : ''}`).join(', ')}. Сушилня се добавя само при заявка.`,
    `Трасета: сценарий ${template.routeMin}–${template.routeMax} м на точка, не измерени дължини. Общите участъци се уточняват по план без двойно броене.`,
    'Само труд. Материали, осветителни тела и монтажът им, окончателно свързване/монтаж на уредите, демонтаж на старата инсталация, възстановяване на стени и измервания/документация не са включени.',
    draft.wallType === 'brick' || draft.wallType === 'concrete' ? 'Къртенето е включено с показаното допускане за дължини.' : 'Къртенето не е включено; уточняваме стените и трасетата отделно.',
    `${template.panelDescriptions[panel] ?? 'Защитите се уточняват по проект.'} Цената за таблото е само за труд, без материалите.`,
    'По една базова осветителна зона на помещение; отделните зони и Shelly не са непременно отделни защитени кръгове. Броят кръгове и сеченията се проверяват от проектант.',
    'Данъчният режим се уточнява в офертата. Това е ориентир за изброената работа, не крайна цена за завършена инсталация.',
    ...(panel === 'panel_custom' ? ['Каталожната цена за индивидуално табло е начална; допълнителната работа не е оценена.'] : []),
  ];
  const rangePreview: RangeEstimate = { currency: 'EUR', min: lines.reduce((n,l) => n+l.min,0), max: lines.reduce((n,l) => n+l.max,0), needsInspection: true, lines, assumptions };
  const why = draft.currentIntent === 'explain' ? 'Уредите определят отделните захранвания, а точките и трасетата определят труда. Затова ги включвам в разбивката.\n' : '';
  const detailed = /разбив|razbiv|подроб|podrob|детайл|detail|как.*смет|kak.*smet/i.test(message);
  const price = `${rangePreview.min.toFixed(2)}–${rangePreview.max.toFixed(2)} EUR`;
  const exclusions = `Материалите, демонтажът, ремонтът на стените, монтажът на осветителни тела и окончателното свързване на уредите са отделно. ${draft.wallType === 'brick' || draft.wallType === 'concrete' ? 'Къртенето е включено по предполагаеми трасета.' : 'Къртенето също не е включено.'}`;
  let reply = detailed
    ? `${why}Ето разбивката за труд: ${price}.\n\n${lines.map(l => `${l.label}: ${l.min.toFixed(2)}${l.max !== l.min ? `–${l.max.toFixed(2)}` : ''} EUR`).join('\n')}\n\n${assumptions.join('\n')}`
    : `${why}За този базов вариант сметката е около ${price} само за труд. Приемам ${rooms} ${rooms === 1 ? 'стая' : 'стаи'} и общо ${spaces} помещения/зони за осветление: ${sockets} контактни точки, ${lights} осветителни извода, ${appliances} захранвания за уреди и монтаж на табло. Количествата без ваши указания са допускания; диапазонът е за трасета по ${template.routeMin}–${template.routeMax} м на точка.\n\n${exclusions} Това не е крайна оферта; измерванията и данъчният режим се уточняват отделно.\n\nИскате ли да покажа разбивката?`;
  const hadEstimate = Boolean(previousDraft?.roomCount || previousDraft?.areaSqm || previousDraft?.propertyType === 'studio');
  if (!detailed && hadEstimate && !why) {
    const changes: string[] = [];
    for (const [field, label] of [['hasBoiler','бойлер'],['hasCooker','печка'],['hasOven','фурна'],['hasHob','плот'],['hasWashingMachine','пералня'],['hasDryer','сушилня'],['hasDishwasher','съдомиялна']] as const) {
      if (draft[field] != null && draft[field] !== previousDraft?.[field]) changes.push(draft[field] ? label : `без ${label}`);
    }
    if (draft.acCount && draft.acCount !== previousDraft?.acCount) changes.push(`${draft.acCount} климатика`);
    if (draft.hasAc === false && previousDraft?.hasAc !== false) changes.push('без климатици');
    if (changes.length) {
      reply = `Добре, смятам ${changes.join(', ')}. Ориентирът става ${price} само за труд, при същите допускания за точките и трасетата. Материалите и монтажът на самите уреди са отделно; останалите изключения от базовия вариант остават.`;
    } else if (/gore\s*d[oou]+l[uou]*|горе\s*долу|priblizitel|приблизител/i.test(message)) {
      reply = `Да — приблизително ${price} само за труда по описания базов вариант. Това е сметката с предполагаеми количества и трасета; материалите и посочените допълнителни работи са отделно. Можем да я уточняваме постепенно, без да знаете предварително всички точки.`;
    }
  }
  const updatedDraft = { ...draft, templateVersion: BASIC_HOME.version };
  if (detailed) delete updatedDraft.pendingOffer;
  else updatedDraft.pendingOffer = 'breakdown';
  return { status: 'preview' as const, draft: updatedDraft, rangePreview, reply, circuitProposal: proposedCircuits(draft, rooms, template) };
}
