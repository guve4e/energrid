import { Injectable } from '@nestjs/common';

@Injectable()
export class PropagationEngine {

  estimate(input: {

    upstreamLevel: number;

    downstreamLevel: number;

    upstreamDelta24h: number;

    travelHours: number;

  }) {

    const pulse =

      input.upstreamDelta24h;

    const expectedArrival =

      new Date(

        Date.now()

        +

        input.travelHours * 3600000,

      );

    return {

      pulse,

      expectedArrival,

      influence:

        Math.min(

          Math.abs(pulse) / 20,

          1,

        ),

    };

  }

}
