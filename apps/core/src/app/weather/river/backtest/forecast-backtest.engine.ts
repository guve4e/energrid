import { Injectable } from '@nestjs/common';

@Injectable()
export class ForecastBacktestEngine {

  evaluate(predictions: {

    predicted: number;

    actual: number;

  }[]) {

    if (!predictions.length) {

      return null;

    }

    const mae =

      predictions.reduce(

        (sum,p)=>

          sum+

          Math.abs(

            p.predicted-

            p.actual,

          ),

        0,

      )/

      predictions.length;

    const rmse = Math.sqrt(

      predictions.reduce(

        (sum,p)=>

          sum+

          Math.pow(

            p.predicted-

            p.actual,

            2,

          ),

        0,

      )/

      predictions.length,

    );

    return {

      samples:

        predictions.length,

      mae:

        Number(mae.toFixed(2)),

      rmse:

        Number(rmse.toFixed(2)),

    };

  }

}
