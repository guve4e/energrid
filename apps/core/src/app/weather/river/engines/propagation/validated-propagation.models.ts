import {
  DailyPropagationModel,
} from './daily-propagation.engine';

/*
 * Validated independently on:
 *
 * 2018–2019
 * 2020–2021
 * 2022–2023
 * 2024–2025
 *
 * Coefficients were effectively stable across every
 * expanding-window backtest:
 *
 * upstreamWeight: 0.550–0.552
 * localWeight:    0.020–0.022
 */
export const NOVO_SELO_TO_LOM_DAILY_MODEL:
  DailyPropagationModel = {
    upstreamStation: 'novo-selo',
    downstreamStation: 'lom',

    intercept: 0.004,
    localWeight: 0.021,
    upstreamWeight: 0.551,

    lagDays: 0,

    validation: {
      periods: [
        '2018-2019',
        '2020-2021',
        '2022-2023',
        '2024-2025',
      ],

      maeRangeCm: {
        minimum: 8.57,
        maximum: 9.33,
      },

      directionAccuracyRangePct: {
        minimum: 66.3,
        maximum: 71.7,
      },

      upstreamValueAddedRangePct: {
        minimum: 17.8,
        maximum: 24.0,
      },
    },
  };
