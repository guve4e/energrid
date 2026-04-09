require('ts-node/register');

const {
  getDraftNextAction,
} = require('../../../libs/domain-estimator/src/index.ts');

const draftMissing = {
  tenantSlug: 'energrid',
  includeConsultation: true,
  points: [
    {
      kind: 'power_point',
      quantity: 3
    }
  ],
  devices: [],
  panels: [],
  notes: 'test missing length'
};

const draftReady = {
  tenantSlug: 'energrid',
  includeConsultation: true,
  points: [
    {
      kind: 'power_point',
      quantity: 3,
      routeLengthMeters: 4,
      wallType: 'brick'
    }
  ],
  devices: [],
  panels: [],
  notes: 'ready'
};

console.log('missing draft action:');
console.log(JSON.stringify(getDraftNextAction(draftMissing), null, 2));

console.log('ready draft action:');
console.log(JSON.stringify(getDraftNextAction(draftReady), null, 2));
