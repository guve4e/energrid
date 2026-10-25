import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceIntelligenceObservationIngress } from './device-intelligence-observation-ingress';
import { DeviceObservationStateStore } from './device-observation-state.store';
import type { DeviceInstallationRecord } from './device-installation.store';
import { energridHttpObservationApproval } from './adapters/inbound/energrid/energrid-http-observation-approval';
import {
  ENERGRID_HTTP_OBSERVATION_SOURCE,
  ENERGRID_HTTP_STATUS_SELECTOR,
  energridFirmwareSampleEvidenceId,
} from './adapters/inbound/energrid/energrid-http-observation.adapter';

describe('one ESP8266 sample delivered over HTTP and MQTT', () => {
  it.each(['http-first', 'mqtt-first'] as const)(
    'stores one accepted state and one history batch when %s',
    async firstTransport => {
      const directory = await mkdtemp(join(tmpdir(), 'energrid-dual-transport-'));
      const scope = { tenantId: 'tenant-demo', siteId: 'site-device-lab' };
      const deviceId = 'device:device-lab-vlan:esp8266:a1b2c3';
      const physicalId = 'esp8266:a1b2c3';
      const device = { id: deviceId, ...scope, kind: 'physical', trustStatus: 'approved', metadata: { physicalId } };
      const installation = {
        schemaVersion: 1, device, observationAuthority: energridHttpObservationApproval(deviceId),
      } as unknown as DeviceInstallationRecord;
      const registry = {
        ensureInstallationsLoaded: jest.fn(),
        getDevices: jest.fn().mockReturnValue([device]),
      };
      const installations = { get: jest.fn().mockResolvedValue(installation) };
      const enrollment = { find: jest.fn().mockResolvedValue({ status: 'enrolled' }) };
      const history = { persistAccepted: jest.fn().mockResolvedValue([
        { field: 'temperature', outcome: 'stored' }, { field: 'humidity', outcome: 'stored' },
      ]) };
      const store = new DeviceObservationStateStore(directory);
      const ingress = new DeviceIntelligenceObservationIngress(
        registry as never, installations as never, enrollment as never, store, history as never,
      );
      const sampleId = '0123456789abcdef0123456789abcdef:7:30000';
      const evidenceId = energridFirmwareSampleEvidenceId(physicalId, sampleId)!;
      const values = { temperatureC: 28.25, humidityPct: 48 };
      const httpInput = {
        scope, deviceId, sourceId: ENERGRID_HTTP_OBSERVATION_SOURCE,
        selector: ENERGRID_HTTP_STATUS_SELECTOR, payload: values, evidenceId,
      };
      const topic = `energrid/tenant-demo/site-device-lab/devices/${deviceId}/telemetry`;
      const mqttSource = 'energrid-lab-mqtt';
      const mqttInput = {
        scope, deviceId, sourceId: mqttSource, selector: topic, payload: values, evidenceId,
      };
      const mqttAuthority = {
        binding: {
          deviceId, sourceId: mqttSource, selector: topic,
          fields: {
            temperature: { rawKey: 'temperatureC', type: 'number' as const },
            humidity: { rawKey: 'humidityPct', type: 'number' as const },
          },
        },
        policy: { deviceId, allowedSourcesByField: { temperature: [mqttSource], humidity: [mqttSource] } },
      };

      try {
        const first = firstTransport === 'http'
          ? await ingress.ingest(httpInput)
          : await ingress.ingestConfiguredMqtt(mqttInput, mqttAuthority);
        const second = firstTransport === 'http'
          ? await ingress.ingestConfiguredMqtt(mqttInput, mqttAuthority)
          : await ingress.ingest(httpInput);

        expect(first).toMatchObject({ outcome: 'processed', accepted: true });
        expect(second).toMatchObject({ outcome: 'processed', accepted: false, reason: 'duplicate_evidence' });
        expect(history.persistAccepted).toHaveBeenCalledTimes(1);
        expect(history.persistAccepted).toHaveBeenCalledWith(expect.objectContaining({
          deviceId, evidenceId, fields: expect.arrayContaining([
            expect.objectContaining({ field: 'temperature', value: 28.25 }),
            expect.objectContaining({ field: 'humidity', value: 48 }),
          ]),
        }));
        const state = await store.getState(scope, deviceId);
        expect(state?.fields.temperature.value).toBe(28.25);
        expect(state?.fields.humidity.value).toBe(48);
        expect(await store.decisions(scope, deviceId)).toHaveLength(1);
      } finally {
        await store.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
