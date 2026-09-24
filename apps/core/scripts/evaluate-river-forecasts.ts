import { Pool } from 'pg';
import { RiverForecastEvaluatorService } from '../src/app/weather/river/forecast-monitoring/river-forecast-evaluator.service';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
new RiverForecastEvaluatorService(pool).evaluateDueForecasts()
  .then(result => console.log(result))
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
