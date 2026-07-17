import { Injectable } from '@nestjs/common';

export interface RiverPropagation {

  upstream: string;

  downstream: string;

  averageHours: number;

  confidence: "high" | "medium" | "low";

}

@Injectable()
export class TravelTimeEngine {

  private readonly routes: RiverPropagation[] = [

    {
      upstream: "novo-selo",
      downstream: "vidin",
      averageHours: 8,
      confidence: "medium",
    },

    {
      upstream: "lom",
      downstream: "vidin",
      averageHours: -6,
      confidence: "low",
    },

    {
      upstream: "oryahovo",
      downstream: "vidin",
      averageHours: -16,
      confidence: "low",
    },

  ];

  find(
    upstream: string,
    downstream: string,
  ) {

    return this.routes.find(r =>

      r.upstream === upstream.toLowerCase()

      &&

      r.downstream === downstream.toLowerCase()

    ) ?? null;

  }

}
