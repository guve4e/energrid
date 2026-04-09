require('ts-node/register');

const {
  validateDraft,
  getQuestionForMissing,
} = require('../../../libs/domain-estimator/src/index.ts');

const draft = {
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
  notes: 'test'
};

const result = validateDraft(draft);

console.log(JSON.stringify(result, null, 2));

if (!result.canPreview && result.missing.length > 0) {
  console.log(getQuestionForMissing(result.missing[0]));
}
