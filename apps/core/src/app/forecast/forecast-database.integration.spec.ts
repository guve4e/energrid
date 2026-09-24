import { Pool } from 'pg';
import { WeatherVerificationService, VIDIN_LOCATION } from '../weather/weather-verification.service';
import { RiverForecastEvaluatorService } from '../weather/river/forecast-monitoring/river-forecast-evaluator.service';
import { RiverForecastPerformanceService } from '../weather/river/forecast-monitoring/river-forecast-performance.service';
import { RiverForecastRecorderService } from '../weather/river/forecast-monitoring/river-forecast-recorder.service';
import { WeatherSnapshot, HOUR_MS } from '../weather/weather-data-quality';

// Opt-in only, isolated from the application's configured database and .env.
const url = process.env.FORECAST_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('forecast PostgreSQL integration', () => {
  let pool: Pool;
  let weather: WeatherVerificationService;
  const source = 'outdoor-test';
  const originalSource = process.env.WEATHER_OBSERVATION_SOURCE;
  const migration = require('../../../migrations/1790208000000_forecast-verification.js');
  const initial = require('../../../migrations/1784298898770_create-river-forecasts.js');
  const now = Date.now();
  const iso = (hours: number) => new Date(now + hours * 3600000).toISOString();
  const q = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  async function apply(direction: 'up' | 'down') {
    const sql: string[] = []; migration[direction]({ sql: (statement: string) => sql.push(statement) });
    await pool.query(sql.join('\n'));
  }
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1','localhost'].includes(parsed.hostname) || parsed.pathname !== '/energrid_forecast_test') {
      throw new Error('Integration tests require the dedicated local energrid_forecast_test database');
    }
    pool = new Pool({ connectionString: url, options: '-c search_path=forecast_verification_test', max: 2 });
    await pool.query('DROP SCHEMA IF EXISTS forecast_verification_test CASCADE; CREATE SCHEMA forecast_verification_test');
    const sql: string[] = [];
    initial.up({
      func: (expression: string) => ({ expression }),
      createTable: (name: string, columns: Record<string, { type: string; notNull?: boolean; primaryKey?: boolean; default?: { expression: string } }>) => {
        sql.push(`CREATE TABLE ${q(name)} (${Object.entries(columns).map(([column, d]) =>
          `${q(column)} ${d.type}${d.notNull ? ' NOT NULL' : ''}${d.primaryKey ? ' PRIMARY KEY' : ''}${d.default ? ' DEFAULT '+d.default.expression : ''}`).join(',')})`);
      },
      addConstraint: (table: string, name: string, constraint: { check: string }) => sql.push(`ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(name)} CHECK (${constraint.check})`),
      createIndex: (table: string, columns: string[], options: { name: string; unique?: boolean }) => sql.push(`CREATE ${options.unique ? 'UNIQUE ' : ''}INDEX ${q(options.name)} ON ${q(table)}(${columns.map(q).join(',')})`),
    });
    await pool.query(sql.join(';'));
    await pool.query('CREATE TABLE river_readings(station text,provider text,level_cm numeric,fetched_at timestamptz)');
    await apply('up');
    weather = new WeatherVerificationService(pool);
    process.env.WEATHER_OBSERVATION_SOURCE = source;
  });
  beforeEach(async () => { await pool.query('TRUNCATE weather_forecasts,weather_observations,river_forecasts,river_readings RESTART IDENTITY'); });
  afterAll(async () => {
    if (originalSource == null) delete process.env.WEATHER_OBSERVATION_SOURCE; else process.env.WEATHER_OBSERVATION_SOURCE = originalSource;
    await pool?.end();
  });

  async function prediction(metric = 'temperature_c', predicted = 20, target = iso(-3), windowStart: string | null = null) {
    const result = await pool.query(`INSERT INTO weather_forecasts
      (location,provider,model_version,issued_at,issued_hour,target_at,window_start_at,horizon_hours,metric,predicted,baseline,input_snapshot,created_at)
      VALUES ($1,'open-meteo','icon:weather-v1',$2,$2,$3,$4,6,$5,$6,$7,'{}',$2) RETURNING id`,
    [VIDIN_LOCATION,iso(-10),target,windowStart,metric,predicted,metric === 'temperature_c' ? 18 : null]);
    return result.rows[0].id;
  }
  it('scores measured observations once, persists their identity, and reports accuracy', async () => {
    const id = await prediction();
    const observedAt = iso(-3 + 5/60);
    await weather.ingest(source,VIDIN_LOCATION,[{ metric: 'temperature_c',value: 22,observedAt }]);
    expect((await weather.evaluate()).evaluated).toBe(1);
    expect((await weather.evaluate()).evaluated).toBe(0);
    const row = (await pool.query('SELECT * FROM weather_forecasts WHERE id=$1',[id])).rows[0];
    expect(row.absolute_error).toBe(2); expect(row.baseline_absolute_error).toBe(4); expect(row.observation_id).toBeTruthy();
    const performance = await weather.performance();
    expect(performance.summary[0]).toMatchObject({ samples: 1,mae: 2,rmse: 2,bias: 2,skillVsPersistence: 0.5,observationSource: source });
    expect((await weather.ingest(source,VIDIN_LOCATION,[{ metric:'temperature_c',value:23,observedAt }])).recorded).toBe(0);
  });
  it('persists weather predictions and never overwrites an issued run', async () => {
    const t = Date.now();
    const current = { time:new Date(t).toISOString(),temperature:20,feelsLike:20,humidity:50,pressure:1000,windKmh:10,gustKmh:20,weatherCode:0,condition:'Clear' };
    const snapshot: WeatherSnapshot = { location:'Vidin',coordinates:{latitude:43.9916,longitude:22.8728},provider:'open-meteo',model:'icon_seamless',
      fetchedAt:new Date(t).toISOString(),availability:'available',units:{temperature:'celsius',wind:'km/h',precipitation:'mm'},current,daily:[],alerts:[],
      hourly:Array.from({length:30},(_,i)=>({...current,time:new Date(Math.floor(t/HOUR_MS)*HOUR_MS+i*HOUR_MS).toISOString(),rainChance:80,precipitationMm:2,rainMm:2,showersMm:0})) };
    expect((await weather.record([snapshot],snapshot,new Date(t))).recorded).toBe(18);
    snapshot.hourly.forEach(h=>h.temperature=50);
    expect((await weather.record([snapshot],snapshot,new Date(t))).recorded).toBe(0);
    const row=(await pool.query("SELECT predicted,input_snapshot FROM weather_forecasts WHERE metric='temperature_c' LIMIT 1")).rows[0];
    expect(row.predicted).toBe(20); expect(row.input_snapshot.forecast.temperature).toBe(20);
  });
  it('ignores other stations, unconfigured sources, and observations outside tolerance', async () => {
    await prediction();
    await weather.ingest('other',VIDIN_LOCATION,[{ metric:'temperature_c',value:20,observedAt:iso(-3) }]);
    await weather.ingest(source,'other-site',[{ metric:'temperature_c',value:20,observedAt:iso(-3) }]);
    await weather.ingest(source,VIDIN_LOCATION,[{ metric:'temperature_c',value:20,observedAt:iso(-2) }]);
    expect((await weather.evaluate()).evaluated).toBe(0);
  });
  it('scores hourly rain and event probabilities against matching intervals', async () => {
    await prediction('rain_probability',0.8,iso(-3),iso(-4));
    await prediction('precipitation_mm',3,iso(-3),iso(-4));
    await weather.ingest(source,VIDIN_LOCATION,[{ metric:'precipitation_mm',value:2,observedAt:iso(-3),windowStartAt:iso(-4) }]);
    expect((await weather.evaluate()).evaluated).toBe(2);
    const row = (await pool.query("SELECT * FROM weather_forecasts WHERE metric='rain_probability'")).rows[0];
    expect(row.actual).toBe(1); expect(row.brier_score).toBeCloseTo(0.04);
  });
  it('does not score forecasts recorded after the target, or before the observation window closes', async () => {
    const id = await prediction();
    await pool.query('UPDATE weather_forecasts SET created_at=now() WHERE id=$1',[id]);
    await weather.ingest(source,VIDIN_LOCATION,[{ metric:'temperature_c',value:20,observedAt:iso(-3) }]);
    expect((await weather.evaluate()).evaluated).toBe(0);
    await pool.query('DELETE FROM weather_forecasts');
    await prediction('temperature_c',20,iso(-0.1));
    await weather.ingest(source,VIDIN_LOCATION,[{ metric:'temperature_c',value:20,observedAt:iso(-0.1) }]);
    expect((await weather.evaluate()).evaluated).toBe(0);
  });
  it('makes river recording immutable per hour and keeps real issue time', async () => {
    const recorder = new RiverForecastRecorderService(pool);
    const input = { mainStation: { station:'Vidin',provider:'appd-bg',levelCm:100,fetchedAt:iso(-3) },
      forecast: { projection: { next6h: { expectedCm:110 },next24h:{ expectedCm:120 } } } };
    expect((await recorder.recordDashboardForecasts(input)).recorded).toBe(2);
    input.forecast.projection.next6h.expectedCm = 999;
    expect((await recorder.recordDashboardForecasts(input)).recorded).toBe(0);
    const result = (await pool.query('SELECT * FROM river_forecasts WHERE horizon_hours=6')).rows[0];
    expect(Number(result.predicted_level)).toBe(110);
    expect(result.issued_at.getTime()).toBeGreaterThan(Date.parse(iso(-1)));
  });
  it('matches river provider identity and excludes legacy scores from new evaluation', async () => {
    const insert = `INSERT INTO river_forecasts(station,model_version,issued_at,target_at,horizon_hours,
      observed_level_at_issue,predicted_level,predicted_min,predicted_max,predicted_direction,confidence,input_snapshot,created_at,verification_version)
      VALUES ('Vidin',$1,$2,$3,6,100,110,105,115,'rising','medium','{"sourceReading":{"provider":"appd-bg"}}',$2,$4)`;
    await pool.query(insert,['v2',iso(-10),iso(-3),'river-score-v2']);
    await pool.query(insert,['legacy',iso(-10),iso(-3),'legacy']);
    await pool.query("INSERT INTO river_readings VALUES ('Vidin','wrong-provider',999,$1),('Vidin','appd-bg',112,$2)",[iso(-3),iso(-3+0.1)]);
    const evaluator = new RiverForecastEvaluatorService(pool);
    expect((await evaluator.evaluateDueForecasts()).evaluated).toBe(1);
    expect((await evaluator.evaluateDueForecasts()).evaluated).toBe(0);
    const result = (await pool.query("SELECT * FROM river_forecasts WHERE model_version='v2'")).rows[0];
    expect(Number(result.actual_level)).toBe(112); expect(result.actual_provider).toBe('appd-bg');
    expect(result.observation_time_basis).toBe('provider-time-unverified'); expect(result.direction_correct).toBe(true);
    const performance = await new RiverForecastPerformanceService(pool).getPerformance('Vidin');
    expect(performance.summary[0]).toMatchObject({ samples:1,maeCm:2,baselineMaeCm:12,verificationVersion:'river-score-v2' });
  });
  it('rolls the new migration back and reapplies without removing existing river forecasts', async () => {
    await pool.query(`INSERT INTO river_forecasts(station,model_version,issued_at,target_at,horizon_hours,observed_level_at_issue,predicted_level,predicted_direction,confidence)
      VALUES ('Vidin','legacy',now(),now()+interval '6 hours',6,100,110,'rising','low')`);
    await apply('down'); await apply('up');
    expect((await pool.query('SELECT count(*)::int AS count FROM river_forecasts')).rows[0].count).toBe(1);
  });
});
