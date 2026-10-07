import type { EstimateConversationDraft } from './estimate-draft.types';

// Versioned commercial planning defaults. Not a certified design or a legal minimum.
// Keep old versions when changing defaults so stored conversations remain reproducible.
export const RESIDENTIAL_TEMPLATE = Object.freeze({
  version: 'bg-basic-v1' as const,
  socketsPerRoom: 3, kitchenSockets: 3, corridorSockets: 1, bathroomSockets: 1,
  routeMin: 3, routeMax: 6,
  boiler: true, oven: true, hob: true, washer: true, dishwasher: true, dryer: false,
  corridorCount: 1, bathroomCount: 1, terraceCount: 0,
  defaultPanelCode: 'panel_modern',
  panelDescriptions: {
    panel_modern: 'Предвидено е табло с предпазители и защита, която изключва захранването при определени утечки на ток. Тя намалява риска от токов удар, но не го премахва напълно.',
    panel_full_protection: 'Предвидени са отделни защити за кръговете, защита от пренапрежение и контрол на напрежението. Те се подбират за конкретната инсталация и не премахват напълно риска от токов удар.',
    panel_custom: 'Таблото се уточнява по индивидуален проект. Каталожната цена за труда е начална; нужните защити и допълнителната работа се определят според инсталацията.',
  } as Record<string, string>,
});
export type ResidentialTemplate = { [K in keyof typeof RESIDENTIAL_TEMPLATE]: (typeof RESIDENTIAL_TEMPLATE)[K] extends number ? number : (typeof RESIDENTIAL_TEMPLATE)[K] extends boolean ? boolean : (typeof RESIDENTIAL_TEMPLATE)[K] extends string ? string : Record<string, string> };

export function lightingSpaces(draft: EstimateConversationDraft, rooms: number, t: ResidentialTemplate = RESIDENTIAL_TEMPLATE) {
  return rooms + (draft.corridorCount ?? t.corridorCount) + (draft.bathroomCount ?? t.bathroomCount) + Number(draft.separateKitchen ?? false) + (draft.terraceCount ?? t.terraceCount);
}

export function proposedCircuits(draft: EstimateConversationDraft, rooms: number, t: ResidentialTemplate = RESIDENTIAL_TEMPLATE) {
  const circuits: Array<{ id: string; label: string; assumed: boolean }> = [];
  const add = (id: string, label: string, count: number, assumed = true) => {
    for (let i = 0; i < count; i++) circuits.push({ id: `${id}-${i + 1}`, label: `${label}${count > 1 ? ` ${i + 1}` : ''}`, assumed });
  };
  add('lighting', 'Осветление', lightingSpaces(draft, rooms, t));
  add('room-sockets', 'Контакти в стая', rooms);
  add('kitchen-counter', 'Контакти на кухненския плот — предложена дефектнотокова защита', 1);
  for (const [id, label, value, fallback] of [
    ['boiler', 'Бойлер — предложен отделен кръг с RCBO', draft.hasBoiler, t.boiler],
    ['oven', 'Фурна — отделен кръг', draft.hasOven ?? draft.hasCooker, t.oven],
    ['hob', 'Плот — отделен кръг', draft.hasHob ?? draft.hasCooker, t.hob],
    ['washer', 'Пералня', draft.hasWashingMachine, t.washer],
    ['dryer', 'Сушилня', draft.hasDryer, t.dryer],
    ['dishwasher', 'Съдомиялна', draft.hasDishwasher, t.dishwasher],
  ] as const) add(id, label, Number(value ?? fallback), value == null);
  add('ac', 'Климатик', draft.hasAc === false ? 0 : draft.acCount ?? (draft.hasAc ? 1 : rooms), draft.acCount == null);
  return { version: t.version, circuits, note: 'Начално предложение. Коридорните и банските контакти, общите трасета, защитите, сеченията и капацитетът на таблото се уточняват при проектиране. Осветителните зони с отделни ключове/Shelly не са непременно отделни защитени кръгове. Кръговете не са допълнително таксувани точки.' };
}
