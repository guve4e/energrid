export interface TrendAnalysis {
  trend: 'rising' | 'falling' | 'stable';

  rateCmPerHour: number;

  acceleration: number;

  latestLevel: number | null;
}

export class TrendAnalyzer {

  analyze(history: any[]): TrendAnalysis {

    if (history.length < 2) {
      return {
        trend: 'stable',
        rateCmPerHour: 0,
        acceleration: 0,
        latestLevel: history.at(-1)?.levelCm ?? null,
      };
    }

    const first = history[0];
    const last = history.at(-1);

    const hours =
      (new Date(last.fetchedAt).getTime() -
        new Date(first.fetchedAt).getTime()) /
      36e5;

    const rate =
      hours > 0
        ? (last.levelCm - first.levelCm) / hours
        : 0;

    let trend: 'rising' | 'falling' | 'stable' =
      'stable';

    if (rate > 0.25)
      trend = 'rising';

    if (rate < -0.25)
      trend = 'falling';

    const midpoint =
      Math.floor(history.length / 2);

    const firstHalf =
      history.slice(0, midpoint);

    const secondHalf =
      history.slice(midpoint);

    const avg = (rows:any[]) =>
      rows.reduce((s,r)=>s+r.levelCm,0) /
      rows.length;

    const acceleration =
      avg(secondHalf) -
      avg(firstHalf);

    return {
      trend,
      rateCmPerHour: Number(rate.toFixed(2)),
      acceleration: Number(acceleration.toFixed(2)),
      latestLevel: last.levelCm,
    };
  }

}
