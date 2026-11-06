import * as dotenv from 'dotenv';
import * as path from 'path';
import { WeatherObservationCollector } from '../src/app/weather/weather-observation-collector.service';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({
    path: path.resolve(process.cwd(), '.env.auth.local'),
    override: true,
    quiet: true,
  });
}

async function main() {
  const [latitude, longitude, startAt, endAt] = process.argv.slice(2);
  if (!latitude || !longitude || !startAt || !endAt) {
    process.stderr.write(
      'Usage: diagnose-meteostat-stations <latitude> <longitude> <start-utc-hour> <end-utc-hour>\n',
    );
    process.exitCode = 2;
    return;
  }

  const collector = new WeatherObservationCollector({} as never, {} as never);
  const result = await collector.diagnoseAtCoordinates({
    latitude: Number(latitude),
    longitude: Number(longitude),
    metric: 'precipitation_mm',
    startAt,
    endAt,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'available') process.exitCode = 1;
}

void main();
