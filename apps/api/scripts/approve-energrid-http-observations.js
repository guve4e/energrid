#!/usr/bin/env node
'use strict';

require('dotenv').config({ quiet: true });
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', moduleResolution: 'node' },
});

const { DeviceInstallationStore } = require('../src/app/modules/devices/device-installation.store');
const { energridHttpObservationApproval } = require('../src/app/modules/devices/adapters/inbound/energrid/energrid-http-observation-approval');

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const [tenantId, siteId, deviceId, ...extra] = args;
  if (!tenantId || !siteId || !deviceId || extra.length) {
    throw new Error('Usage: node apps/api/scripts/approve-energrid-http-observations.js <tenantId> <siteId> <deviceId>');
  }
  const store = new DeviceInstallationStore();
  try {
    const installation = await store.get(siteId, deviceId);
    if (!installation || installation.device.tenantId !== tenantId ||
      installation.device.siteId !== siteId || installation.device.id !== deviceId ||
      installation.device.trustStatus !== 'approved' ||
      installation.device.adapter.driver !== 'energrid-esp8266' ||
      installation.device.metadata?.physicalId !== `esp8266:${deviceId.split(':').pop()}`) {
      throw new Error('No matching approved Energrid ESP8266 installation exists in this tenant and site.');
    }
    installation.observationAuthority = energridHttpObservationApproval(deviceId);
    installation.updatedAt = new Date().toISOString();
    await store.save(installation);
    process.stdout.write(`Explicitly approved temperature and humidity observations for ${deviceId} in ${tenantId}/${siteId}.\n`);
    process.stdout.write('Enrollment remains separate; no control authority was added.\n');
  } finally {
    await store.onModuleDestroy();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Approval failed'}\n`);
  process.exitCode = 1;
});
