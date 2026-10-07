// Explicit opt-in: four real model calls, no quote/database writes in local-only mode.
const assert = require('node:assert/strict');
if (!process.argv.includes('--live')) {
  console.log('Start the local estimator on port 3021, then run: node apps/core/scripts/test-local-estimator.cjs --live (4 model calls).');
  process.exit(0);
}
(async () => {
  let draft;
  const messages = [
    'iskam nova instalaciq v Garisionerata',
    'Ami normalnite si uredi v ejednevieto',
    'Da, razbira se 4e ima boiler.. i da ima klimatik',
    'Novo 30 kvadrata.. standartna si garsionera',
  ];
  let last;
  for (const message of messages) {
    const response = await fetch('http://127.0.0.1:3021/core/estimator/assistant-step-v2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, draft }), signal: AbortSignal.timeout(30000),
    });
    last = await response.json();
    assert.ok(response.ok, `Estimator HTTP ${response.status}`);
    console.log(last.status, last.reply);
    draft = last.draft;
  }
  assert.equal(last.status, 'preview');
  assert.equal(draft.areaSqm, 30);
  assert.equal(draft.buildingStage, 'new');
  assert.equal(draft.hasBoiler, true);
  assert.equal(draft.hasAc, true);
  assert.ok(last.rangePreview.min > 0);
  assert.ok(last.rangePreview.max >= last.rangePreview.min);
  console.log('PASS: the complete studio conversation produced a labour estimate.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
