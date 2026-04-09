const { createPool } = require('../src/db.ts');
const { EstimatorPersistenceService } = require('../src/estimator/estimator-persistence.service.ts');

async function main() {
  console.log('[persist-test] starting');

  const pool = createPool();
  console.log('[persist-test] pool created');

  const service = new EstimatorPersistenceService(pool);
  console.log('[persist-test] service created');

  const persisted = await service.persistEstimate({
    source: 'manual',
    projectName: 'Smoke test project',
    city: 'Vidin',
    address: 'Test address',
    estimateInput: {
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
    },
  });

  console.log('[persist-test] persisted result:');
  console.log(JSON.stringify({
    projectId: persisted.project.id,
    estimateId: persisted.estimate.id,
    lineCount: persisted.lines.length,
    subtotal: persisted.result.subtotal,
    confidence: persisted.result.confidence,
  }, null, 2));

  await pool.end();
  console.log('[persist-test] done');
}

main().catch((e) => {
  console.error('[persist-test] failed');
  console.error(e);
  process.exit(1);
});
