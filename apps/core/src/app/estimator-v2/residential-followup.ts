import type { EstimateConversationDraft } from './estimate-draft.types';
import { estimateResidential } from './residential-estimate';
import { RESIDENTIAL_TEMPLATE, type ResidentialTemplate } from './residential-template';

export function residentialFollowup(message: string, draft: EstimateConversationDraft) {
  const text = message.toLowerCase().trim();
  const change = /(?:добави|dobavi|махни|mahni|премахни|premahni|смени|smeni|искам|iskam|сложи|sloji)/.test(text);
  const question = /какво|kakvo|за какво|za kakvo|трябва ли|trqbva li|нужно ли|nujno li|tova za|как работи|kak raboti/.test(text);
  // Answer the substantive question before interpreting a leading "yes".
  if (!change && question && /умно.*реле|umno.*rele|shelly/i.test(text)) return 'smart_relay';
  if (!change && question && /кърт|kurt|стен|sten|канал|kanal/.test(text)) return 'chasing';
  // Corrections still go through extraction; questions must not silently change scope.
  if (/\b\d+\b|смени|добави|искам.*(?:табло|контакт)|dobavi|smeni/.test(text)) return undefined;
  if (/ценора[зс]пис|cenorazpis|cenoraspis|price list|каталог|katalog/.test(text)) return 'catalog';
  if (/какво.*точка|означава.*точка|kakvo.*to[4c]ka|ozna[4c]ava.*to[4c]ka/.test(text)) return 'point';
  if (/бушон|bu[6s]on|табло|tablo/.test(text)) return 'panel';
  if (/кръгов|схема|krugov|shema|circuits/.test(text)) return 'circuits';
  if (/разбив|razbiv/.test(text) || (draft.pendingOffer === 'breakdown' && /^(?:да|da|yes|може|moje)(?:\s+(?:моля|molq|please))?[\s.!?,…]*$/.test(text))) return 'breakdown';
  return undefined;
}

export function answerResidentialFollowup(kind: string, draft: EstimateConversationDraft, catalog: Parameters<typeof estimateResidential>[1], template: ResidentialTemplate = RESIDENTIAL_TEMPLATE) {
  const result = estimateResidential(draft, catalog, kind === 'breakdown' ? 'разбивка' : '', undefined, template);
  if (kind === 'breakdown' || !result.rangePreview) return result;
  const unitPrice = (code: string) => {
    const row = catalog.find(r => r.code === code && r.labor_included && !r.materials_included);
    return row && Number.isFinite(Number(row.base_price)) && Number(row.base_price) >= 0 ? Number(row.base_price).toFixed(2) : null;
  };
  let reply = '';
  if (kind === 'smart_relay') reply = `Умното реле е малко устройство, с което например можете да включвате лампата от телефона или по часовник. За обикновено осветление не е нужно — нормалните ключове са достатъчни. ${draft.smartRelayCount ? `В текущата сметка има ${draft.smartRelayCount} бр.; с този въпрос не добавям нови.` : 'Не го добавям към сметката само защото питате за него.'}`;
  if (kind === 'chasing') reply = `Не непременно навсякъде. Ако старите тръби са подходящи и проходими, понякога могат да се използват за новите проводници. За нови места на контакти или непроходими трасета може да са нужни канали или открит монтаж. При панелно жилище трасетата трябва да се преценят на място, преди да се решава къде може да се кърти. ${draft.wallType === 'brick' || draft.wallType === 'concrete' ? 'В текущата сметка вече има допускане за къртене; въпросът ви не променя количествата.' : 'Сегашният ориентир не включва къртене; не добавям такса, преди да уточним дали и колко е нужно.'}`;
  if (kind === 'point') reply = '„Точка“ тук е място, до което изграждаме електрически извод — за контакт, осветление или уред. В цената на точката е заложено трасе до 3 м. Монтажът на контакта/ключа е отделен ред; осветителното тяло и монтажът му не са включени. Един защитен кръг може да обслужва повече от една точка.';
  if (kind === 'panel') {
    const line = result.rangePreview.lines.find(l => l.code.startsWith('panel_'))!;
    reply = `Да, таблото е включено: ${line.min.toFixed(2)} EUR само за труда по избрания вариант в ценоразписа. ${template.panelDescriptions[line.code] ?? 'Видът на защитите се уточнява по проект.'} Самото табло и защитните устройства се плащат отделно като материали. Ще подберем подходящите устройства според инсталацията; не е нужно вие да знаете техническите им имена.`;
  }
  if (kind === 'catalog') {
    const rows = [
      ['power_point_up_to_3m', 'Извод с трасе до 3 м', 'точка'],
      ['power_line_extra_meter_after_3m', 'Допълнително трасе над 3 м', 'м'],
      ['socket_or_switch_concealed', 'Монтаж на контакт/ключ', 'бр.'],
      [template.defaultPanelCode, 'Труд по базовото табло, без устройствата', 'бр.'],
      ['smart_relay_single', 'Монтаж и настройка на единично умно реле', 'бр.'],
    ].flatMap(([code, label, unit]) => { const price = unitPrice(code); return price == null ? [] : [`${label}: ${price} EUR/${unit}`]; });
    reply = `Да, имаме ценоразпис за труда. Ето приложимите позиции от активния каталог:\n${rows.join('\n')}\nМатериалите са отделно. Общата сума зависи от количествата и трасетата. Мога да го покажа тук; нямам потвърден линк към публична страница.`;
  }
  if (kind === 'circuits') reply = `Началното предложение е:\n${result.circuitProposal!.circuits.map(c => `• ${c.label}${c.assumed ? ' (допускане)' : ''}`).join('\n')}\n${result.circuitProposal!.note}`;
  if (kind === 'smart_relay' || kind === 'chasing') return { ...result, reply, draft: { ...result.draft, pendingOffer: draft.pendingOffer } };
  return { ...result, reply: `${reply}\n\nИскате ли разбивката на текущата оценка?`, draft: { ...result.draft, pendingOffer: 'breakdown' as const } };
}
