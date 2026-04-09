const { createPool } = require('../src/db.ts');
const { EstimatorService } = require('../src/estimator/estimator.service.ts');

async function main() {
  const pool = createPool();
  const service = new EstimatorService(pool);

  const result = await service.estimate({
    tenantSlug: 'energrid',
    includeConsultation: true,
    points: [
      {
        kind: 'power_point',
        quantity: 3,
        routeLengthMeters: 4,
        wallType: 'brick',
      },
    ],
    devices: [
      {
        kind: 'socket_or_switch_concealed',
        quantity: 4,
      },
    ],
  });

  console.log(JSON.stringify(result, null, 2));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
