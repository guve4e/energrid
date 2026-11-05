import { Injectable } from '@nestjs/common';
import type { HouseAgentScope } from '../llm/house-agent.port';

@Injectable()
export class WeatherAssistantQueryService {
  async answer(
    scope: HouseAgentScope,
    message: string,
  ): Promise<string | null> {
    if (
      !/(времето|прогноз|снег|сняг|буря|бури|градуш|студ|застуд|вятър|дъжд|предупред.*врем|около къщ)/iu.test(
        message,
      )
    )
      return null;
    const token = process.env.WEATHER_INVESTIGATOR_API_TOKEN?.trim();
    if (!token)
      return 'В момента нямам връзка със запазените данни за времето.';
    const base = (
      process.env.ENERGRID_CORE_URL || 'http://127.0.0.1:3020'
    ).replace(/\/$/, '');
    const query = new URLSearchParams({
      tenantId: scope.tenantId,
      siteId: scope.siteId,
    });
    try {
      const response = await fetch(
        `${base}/core/weather/investigator/read-model?${query}`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok)
        return 'Запазените данни за времето в момента не са достъпни.';
      const context = (await response.json()) as {
        version?: number;
        status?: 'available' | 'partial' | 'stale' | 'unavailable';
        findings?: Array<{
          eventType: string;
          startsAt: string;
          endsAt: string;
          location: string;
          explanationBg: string;
          uncertainty: string;
          evidenceRefs: string[];
          consequences: string[];
          preparation: string[];
          provider: string;
          model: string;
          lastUpdatedAt: string;
          notificationState: string;
        }>;
        forecast?: {
          capturedAt: string;
          provider: string;
          model: string | null;
          location: string;
          hours?: Array<{
              id: string;
              time: string;
              temperatureC: number | null;
              rainProbabilityPercent: number | null;
              precipitationMm: number | null;
              gustKmh: number | null;
              weatherCode: number | null;
            }>;
        } | null;
        officialAlerts?: { status: 'unsupported'; explanation: string };
      };
      if (context.version !== 1)
        return 'Данните за времето са с неподдържан формат и не могат да бъдат проверени.';
      if (context.status !== 'available') {
        const reason = context.status === 'stale' ? 'остаряла' :
          context.status === 'partial' ? 'непълна' : 'недостъпна';
        return `Запазената прогноза е ${reason}. Няма достатъчно надеждни данни за текуща оценка. ${context.officialAlerts?.explanation ?? 'Официалните предупреждения не са проверени.'}`;
      }
      const findings = Array.isArray(context.findings) ? context.findings : [];
      const latest = context.forecast;
      if (!findings.length && !latest)
        return 'Все още няма запазена прогноза за този дом. Официалните предупреждения не са налични от текущия източник.';
      const rows = findings
        .slice(0, 4)
        .map(
          (finding) =>
            `${finding.explanationBg} Период: ${new Date(finding.startsAt).toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' })} – ${new Date(finding.endsAt).toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' })}. ${finding.consequences?.length ? `Възможни последици: ${finding.consequences.join(' ')}` : ''} ${finding.preparation?.length ? `Подготовка: ${finding.preparation.join(' ')}` : ''} Доказателства: ${finding.evidenceRefs.join(', ')}; източник ${finding.provider}/${finding.model}, обновено ${new Date(finding.lastUpdatedAt).toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' })}. ${finding.uncertainty}`,
        );
      const hours = latest?.hours ?? [];
      const events = hours
        .filter(
          (hour) =>
            [71, 73, 75, 77, 85, 86, 95, 96, 99].includes(
              hour.weatherCode ?? -1,
            ) ||
            ((hour.rainProbabilityPercent ?? 0) >= 50 &&
              (hour.precipitationMm ?? 0) > 0) ||
            (hour.gustKmh ?? 0) >= 50,
        )
        .slice(0, 4);
      const forecastSummary = events.map((hour) => {
        const kinds = [
          ...([71, 73, 75, 77, 85, 86].includes(hour.weatherCode ?? -1)
            ? ['сняг']
            : []),
          ...([95, 96, 99].includes(hour.weatherCode ?? -1)
            ? ['гръмотевична буря']
            : []),
          ...((hour.rainProbabilityPercent ?? 0) >= 50 &&
          (hour.precipitationMm ?? 0) > 0
            ? [
                `дъжд с ${hour.rainProbabilityPercent}% вероятност и ${hour.precipitationMm} mm прогнозно количество`,
              ]
            : []),
          ...((hour.gustKmh ?? 0) >= 50
            ? [`пориви до ${hour.gustKmh} km/h`]
            : []),
        ];
        return `${new Date(hour.time).toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' })}: ${kinds.join(', ')} [${hour.id}]`;
      });
      const location = latest?.location ?? findings[0]?.location ?? 'дома';
      return `Данни за ${location}, прогноза от ${latest?.provider}/${latest?.model ?? 'непосочен модел'}, получена ${latest?.capturedAt ? new Date(latest.capturedAt).toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' }) : 'неизвестно време'}. ${rows.length ? rows.join(' ') : 'Няма запазени активни констатации.'} ${forecastSummary.length ? `В прогнозата се виждат: ${forecastSummary.join('; ')}.` : 'В наличните часове не са открити посочените сигнали, което не гарантира безопасни условия.'} ${context.officialAlerts?.explanation ?? 'Официалните предупреждения не са проверени.'}`;
    } catch {
      return 'Запазените данни за времето в момента не са достъпни.';
    }
  }
}
