import { Injectable } from '@nestjs/common';

export interface RiverState {

  level: number;

  delta24h: number;

  delta3d?: number | null;

  discharge?: number | null;

  temperature?: number | null;

  month?: number;

}

@Injectable()
export class HistoricalAnalogueEngine {

  private readonly LEVEL_WEIGHT = 1.0;

  private readonly DELTA_WEIGHT = 2.0;

  private readonly DELTA_3D_WEIGHT = 0.75;

  private readonly DISCHARGE_WEIGHT = 1 / 500;

  private readonly TEMPERATURE_WEIGHT = 1.0;

  private readonly MONTH_PENALTY = 20;

  score(
    current: RiverState,
    candidate: RiverState,
  ) {

    let score = 0;

    score +=
      Math.abs(
        current.level -
        candidate.level,
      ) * this.LEVEL_WEIGHT;

    score +=
      Math.abs(
        current.delta24h -
        candidate.delta24h,
      ) * this.DELTA_WEIGHT;

    if (
      current.delta3d != null &&
      candidate.delta3d != null
    ) {
      score +=
        Math.abs(
          current.delta3d -
          candidate.delta3d,
        ) * this.DELTA_3D_WEIGHT;
    }

    if (
      current.discharge != null &&
      candidate.discharge != null
    ) {
      score +=
        Math.abs(
          current.discharge -
          candidate.discharge,
        ) * this.DISCHARGE_WEIGHT;
    }

    if (
      current.temperature != null &&
      candidate.temperature != null
    ) {
      score +=
        Math.abs(
          current.temperature -
          candidate.temperature,
        ) * this.TEMPERATURE_WEIGHT;
    }

    if (
      current.month != null &&
      candidate.month != null &&
      current.month !== candidate.month
    ) {
      score += this.MONTH_PENALTY;
    }

    return Number(score.toFixed(3));

  }

}
