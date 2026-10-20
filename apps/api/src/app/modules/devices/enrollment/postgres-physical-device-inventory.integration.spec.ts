import { randomUUID } from 'node:crypto';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { PostgresDeviceEnrollmentRepository } from './postgres-device-enrollment.repository';
import { PostgresPhysicalDeviceInventoryRepository } from './postgres-physical-device-inventory.repository';
import { createVerifiedEnrollmentTestPool } from './postgres-integration-test-database';

const testWithDatabase = process.env.ENERGRID_ENROLLMENT_TEST_DATABASE_URL ? it : it.skip;

describe('PostgreSQL physical-device inventory integration', () => {
  testWithDatabase('persists the first protocol-observed network observation without enrolling the device', async () => {
    const pool = await createVerifiedEnrollmentTestPool({ max: 2, connectionTimeoutMillis: 1000 });
    const runId = randomUUID();
    const tenantId = `first-observation-test-${runId}`;
    const siteId = `site-${runId}`;
    const scope = { tenantId, siteId };
    const repository = new PostgresPhysicalDeviceInventoryRepository(pool);

    try {
      const physical = await repository.discover({
        scope,
        identity: { namespace: 'mqtt:shelly-protocol-id', value: `shellyproem50-${runId}` },
        evidenceSource: 'mqtt_protocol_message',
        observedAt: '2026-10-19T12:00:00.000Z',
        components: [
          { key: 'em1:0', capabilities: ['power'] },
          { key: 'em1:1', capabilities: ['power'] },
        ],
      });

      await repository.refreshNetworkObservations(scope, [{
        physicalDeviceId: physical.physicalDeviceId,
        ipAddress: '192.168.1.203',
        macAddress: 'aa:bb:cc:dd:ee:01',
        gatewayId: 'gateway-home',
        networkScope: 'gateway-home:first-observation:iot',
        observedAt: '2026-10-19T12:00:02.000Z',
        evidenceSource: 'lan_discovery_protocol_match',
      }]);

      const restartPool = await createVerifiedEnrollmentTestPool({ max: 1, connectionTimeoutMillis: 1000 });
      try {
        const persisted = await new PostgresPhysicalDeviceInventoryRepository(restartPool)
          .get(scope, physical.physicalDeviceId);
        expect(persisted?.networkObservations).toEqual(expect.arrayContaining([
          expect.objectContaining({
            ipAddress: '192.168.1.203',
            macAddress: 'aa:bb:cc:dd:ee:01',
            networkScope: 'gateway-home:first-observation:iot',
            observedAt: '2026-10-19T12:00:02.000Z',
            evidenceSource: 'lan_discovery_protocol_match',
            verificationStatus: 'protocol_observed',
            associatedAt: null,
            associatedBy: null,
            isCurrent: true,
          }),
        ]));
        expect(persisted?.components.map(component => component.key)).toEqual(['em1:0', 'em1:1']);
        expect(persisted?.assignments).toEqual([]);
        const enrollments = await restartPool.query(
          'SELECT 1 FROM device_inventory.enrollments WHERE tenant_id=$1 AND site_id=$2',
          [tenantId, siteId],
        );
        expect(enrollments.rows).toEqual([]);
      } finally {
        await restartPool.end();
      }
    } finally {
      await pool.query('DELETE FROM device_inventory.physical_device_network_observations WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_device_endpoints WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_device_components WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_device_identity_claims WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_devices WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.end();
    }
  });

  testWithDatabase('keeps current network observations per physical device rather than assigning IP ownership', async () => {
    const pool = await createVerifiedEnrollmentTestPool({ max: 2, connectionTimeoutMillis: 1000 });
    const runId = randomUUID();
    const tenantId = `network-current-semantics-${runId}`;
    const siteId = `site-${runId}`;
    const scope = { tenantId, siteId };
    const repository = new PostgresPhysicalDeviceInventoryRepository(pool);
    const homeScope = 'gateway-home:iot';
    const guestScope = 'gateway-guest:iot';
    let deviceAId = '';
    let deviceBId = '';

    try {
      const [deviceA, deviceB] = await Promise.all([
        repository.discover({
          scope,
          identity: { namespace: 'mqtt:shelly-protocol-id', value: `device-a-${runId}` },
          evidenceSource: 'mqtt_protocol_message',
          observedAt: '2026-10-19T12:00:00.000Z',
          components: [
            { key: 'switch:0', capabilities: ['turn_on', 'turn_off'] },
            { key: 'switch:1', capabilities: ['turn_on', 'turn_off'] },
          ],
        }),
        repository.discover({
          scope,
          identity: { namespace: 'mqtt:shelly-protocol-id', value: `device-b-${runId}` },
          evidenceSource: 'mqtt_protocol_message',
          observedAt: '2026-10-19T12:01:00.000Z',
          components: [
            { key: 'switch:0', capabilities: ['turn_on', 'turn_off'] },
            { key: 'switch:1', capabilities: ['turn_on', 'turn_off'] },
          ],
        }),
      ]);
      deviceAId = deviceA.physicalDeviceId;
      deviceBId = deviceB.physicalDeviceId;

      await repository.refreshNetworkObservations(scope, [{
        physicalDeviceId: deviceAId,
        ipAddress: '192.168.1.133',
        macAddress: '02:00:00:00:00:0a',
        networkScope: homeScope,
        observedAt: '2026-10-19T12:10:00.000Z',
        evidenceSource: 'lan_discovery_protocol_match',
      }]);
      await repository.refreshNetworkObservations(scope, [{
        physicalDeviceId: deviceBId,
        ipAddress: '192.168.1.133',
        macAddress: '02:00:00:00:00:0b',
        networkScope: homeScope,
        observedAt: '2026-10-19T12:20:00.000Z',
        evidenceSource: 'lan_discovery_protocol_match',
      }]);
      await repository.refreshNetworkObservations(scope, [{
        physicalDeviceId: deviceAId,
        ipAddress: '192.168.50.20',
        macAddress: '02:00:00:00:00:0a',
        networkScope: guestScope,
        observedAt: '2026-10-19T12:25:00.000Z',
        evidenceSource: 'lan_discovery_protocol_match',
      }]);

      const [aAtReuse, bAtReuse] = await Promise.all([
        repository.get(scope, deviceAId),
        repository.get(scope, deviceBId),
      ]);
      expect(aAtReuse?.physicalDeviceId).not.toBe(bAtReuse?.physicalDeviceId);
      expect(aAtReuse?.components.map(component => component.key)).toEqual(['switch:0', 'switch:1']);
      expect(bAtReuse?.components.map(component => component.key)).toEqual(['switch:0', 'switch:1']);
      expect(aAtReuse?.networkObservations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          ipAddress: '192.168.1.133', networkScope: homeScope, isCurrent: true,
          macAddress: '02:00:00:00:00:0a', observedAt: '2026-10-19T12:10:00.000Z',
        }),
        expect.objectContaining({
          ipAddress: '192.168.50.20', networkScope: guestScope, isCurrent: true,
          macAddress: '02:00:00:00:00:0a', observedAt: '2026-10-19T12:25:00.000Z',
        }),
      ]));
      expect(bAtReuse?.networkObservations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          ipAddress: '192.168.1.133', networkScope: homeScope, isCurrent: true,
          macAddress: '02:00:00:00:00:0b', observedAt: '2026-10-19T12:20:00.000Z',
        }),
      ]));

      await repository.refreshNetworkObservations(scope, [{
        physicalDeviceId: deviceAId,
        ipAddress: '192.168.1.140',
        macAddress: '02:00:00:00:00:0a',
        networkScope: homeScope,
        observedAt: '2026-10-19T12:30:00.000Z',
        evidenceSource: 'lan_discovery_protocol_match',
      }]);
      const [aAfterMove, bAfterMove] = await Promise.all([
        repository.get(scope, deviceAId),
        repository.get(scope, deviceBId),
      ]);
      expect(aAfterMove?.networkObservations).toEqual(expect.arrayContaining([
        expect.objectContaining({ ipAddress: '192.168.1.133', networkScope: homeScope, isCurrent: false }),
        expect.objectContaining({ ipAddress: '192.168.1.140', networkScope: homeScope, isCurrent: true }),
      ]));
      expect(bAfterMove?.networkObservations).toEqual(expect.arrayContaining([
        expect.objectContaining({ ipAddress: '192.168.1.133', networkScope: homeScope, isCurrent: true }),
      ]));
    } finally {
      await pool.query('DELETE FROM device_inventory.physical_device_network_observations WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_device_components WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_device_identity_claims WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_devices WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.end();
    }
  }, 30000);

  testWithDatabase('keeps endpoint address and timestamp at the newest accepted observation', async () => {
    const pool = await createVerifiedEnrollmentTestPool({ max: 6, connectionTimeoutMillis: 1000 });
    const runId = randomUUID();
    const tenantId = `endpoint-order-test-${runId}`;
    const siteId = `site-${runId}`;
    const scope = { tenantId, siteId };
    const repository = new PostgresPhysicalDeviceInventoryRepository(pool);

    try {
      const discover = (observedAt: string, address: string) => repository.discover({
        scope,
        identity: { namespace: 'mqtt:shelly-protocol-id', value: `shellypro2pm-${runId}` },
        evidenceSource: 'integration_test',
        observedAt,
        components: [{ key: 'switch:0', capabilities: ['turn_on', 'turn_off'] }],
        endpoint: { protocol: 'http', kind: 'rpc', address },
      });

      const first = await discover('2026-10-19T12:00:00.000Z', 'http://192.168.1.10/rpc');
      const newer = await discover('2026-10-19T12:00:10.000Z', 'http://192.168.1.20/rpc');
      expect(newer.physicalDeviceId).toBe(first.physicalDeviceId);

      const stale = await discover('2026-10-19T12:00:05.000Z', 'http://192.168.1.15/rpc');
      expect(stale.endpoints.find(endpoint => endpoint.protocol === 'http' && endpoint.kind === 'rpc'))
        .toMatchObject({ address: 'http://192.168.1.20/rpc', lastSeenAt: '2026-10-19T12:00:10.000Z' });

      const duplicate = await discover('2026-10-19T12:00:10.000Z', 'http://192.168.1.20/rpc');
      expect(duplicate.endpoints.find(endpoint => endpoint.protocol === 'http' && endpoint.kind === 'rpc'))
        .toMatchObject({ address: 'http://192.168.1.20/rpc', lastSeenAt: '2026-10-19T12:00:10.000Z' });

      await discover('2026-10-19T12:00:20.000Z', 'http://192.168.1.30/rpc');
      const equalTimestamp = await discover('2026-10-19T12:00:20.000Z', 'http://192.168.1.25/rpc');
      expect(equalTimestamp.endpoints.find(endpoint => endpoint.protocol === 'http' && endpoint.kind === 'rpc'))
        .toMatchObject({ address: 'http://192.168.1.30/rpc', lastSeenAt: '2026-10-19T12:00:20.000Z' });

      const concurrent = await Promise.all([
        discover('2026-10-19T12:00:30.000Z', 'http://192.168.1.30/rpc'),
        discover('2026-10-19T12:00:25.000Z', 'http://192.168.1.25/rpc'),
        discover('2026-10-19T12:00:35.000Z', 'http://192.168.1.35/rpc'),
      ]);
      expect(concurrent.every(record => record.physicalDeviceId === first.physicalDeviceId)).toBe(true);

      const restartPool = await createVerifiedEnrollmentTestPool({ max: 1, connectionTimeoutMillis: 1000 });
      try {
        const persisted = await new PostgresPhysicalDeviceInventoryRepository(restartPool)
          .get(scope, first.physicalDeviceId);
        expect(persisted?.endpoints.filter(endpoint => endpoint.protocol === 'http' && endpoint.kind === 'rpc'))
          .toEqual([expect.objectContaining({ address: 'http://192.168.1.35/rpc', lastSeenAt: '2026-10-19T12:00:35.000Z' })]);
        expect(persisted?.components).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'switch:0' })]));
        const endpointRows = await restartPool.query(
          `SELECT address, last_seen_at FROM device_inventory.physical_device_endpoints
           WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 AND protocol='http' AND endpoint_kind='rpc'`,
          [tenantId, siteId, first.physicalDeviceId],
        );
        expect(endpointRows.rows).toHaveLength(1);
        expect(endpointRows.rows[0]).toMatchObject({ address: 'http://192.168.1.35/rpc' });
        expect(new Date(endpointRows.rows[0].last_seen_at).toISOString()).toBe('2026-10-19T12:00:35.000Z');
      } finally {
        await restartPool.end();
      }
    } finally {
      await pool.query('DELETE FROM device_inventory.physical_device_endpoints WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_device_components WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_device_identity_claims WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.query('DELETE FROM device_inventory.physical_devices WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]);
      await pool.end();
    }
  }, 15000);

  testWithDatabase('persists one multi-channel device, assignments, prefix changes, DHCP history, and MAC conflicts', async () => {
    const pool = await createVerifiedEnrollmentTestPool({ max: 3, connectionTimeoutMillis: 1000 });
    const runId = randomUUID();
    const tenantId = `physical-test-${runId}`;
    const siteId = `site-${runId}`;
    const isolatedSiteId = `isolated-site-${runId}`;
    const boiler = { tenantId, siteId, deviceId: 'boiler-logical' };
    const oven = { tenantId, siteId, deviceId: 'oven-logical' };
    const enrollment = new DeviceEnrollmentService(new PostgresDeviceEnrollmentRepository(pool));
    const repository = new PostgresPhysicalDeviceInventoryRepository(pool);
    const observedAt = '2026-10-19T12:00:00.000Z';
    let physicalDeviceId = '';

    try {
      await enrollment.enroll({ ...boiler, displayName: 'Boiler' }, 'integration-test');
      await enrollment.enroll({ ...oven, displayName: 'Oven' }, 'integration-test');
      const physical = await repository.discover({
        scope: { tenantId, siteId },
        identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyproem50-08f9e0e84910' },
        evidenceSource: 'mqtt_protocol_message',
        observedAt,
        endpoint: { protocol: 'mqtt', kind: 'telemetry', address: 'shelly/boiler@oven/events/rpc' },
        components: [
          { key: 'em1:0', capabilities: ['power'] },
          { key: 'em1:1', capabilities: ['power'] },
        ],
      });
      physicalDeviceId = physical.physicalDeviceId;

      const rpcDiscovery = await repository.discover({
        scope: { tenantId, siteId },
        identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyproem50-08f9e0e84910' },
        evidenceSource: 'lan_http_rpc_identity',
        observedAt: '2026-10-19T12:00:05.000Z',
        endpoint: { protocol: 'http', kind: 'rpc', address: 'http://192.168.1.204/rpc' },
        components: [
          { key: 'em1:0', capabilities: ['power'] },
          { key: 'em1:1', capabilities: ['power'] },
        ],
      });
      expect(rpcDiscovery.physicalDeviceId).toBe(physicalDeviceId);
      expect(rpcDiscovery.components.map(component => component.key)).toEqual(['em1:0', 'em1:1']);
      expect(rpcDiscovery.endpoints).toEqual(expect.arrayContaining([
        expect.objectContaining({ protocol: 'mqtt', kind: 'telemetry' }),
        expect.objectContaining({ protocol: 'http', kind: 'rpc' }),
      ]));

      const afterPrefixChange = await repository.discover({
        scope: { tenantId, siteId },
        identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyproem50-08f9e0e84910' },
        evidenceSource: 'mqtt_protocol_message',
        observedAt: '2026-10-19T12:00:15.000Z',
        endpoint: { protocol: 'mqtt', kind: 'telemetry', address: 'renamed-prefix/events/rpc' },
        components: [{ key: 'em1:0', capabilities: ['power'] }],
      });
      expect(afterPrefixChange.physicalDeviceId).toBe(physicalDeviceId);
      expect(afterPrefixChange.components.map(component => component.key)).toEqual(['em1:0', 'em1:1']);
      expect(afterPrefixChange.endpoints.find(endpoint => endpoint.protocol === 'mqtt')?.address)
        .toBe('renamed-prefix/events/rpc');

      const otherSite = await repository.discover({
        scope: { tenantId, siteId: isolatedSiteId },
        identity: { namespace: 'mqtt:shelly-protocol-id', value: 'shellyproem50-08f9e0e84910' },
        evidenceSource: 'mqtt_protocol_message', observedAt: '2026-10-19T12:00:30.000Z',
        components: [{ key: 'em1:0', capabilities: ['power'] }],
      });
      expect(otherSite.physicalDeviceId).not.toBe(physicalDeviceId);

      const concurrentDiscoveries = await Promise.all(
        ['a', 'b', 'c'].map((suffix, index) => repository.discover({
          scope: { tenantId, siteId },
          identity: { namespace: 'mqtt:shelly-protocol-id', value: `shellypro3em-concurrent-${suffix}` },
          evidenceSource: 'mqtt_protocol_message',
          observedAt: `2026-10-19T12:01:0${index}.000Z`,
          components: [{ key: 'em1:0', capabilities: ['power'] }],
        })),
      );
      expect(new Set(concurrentDiscoveries.map(record => record.physicalDeviceId)).size)
        .toBe(3);

      await repository.assignComponent({
        scope: { tenantId, siteId }, device: boiler, physicalDeviceId, componentKey: 'em1:0',
        role: 'Boiler', assignedAt: observedAt, assignedBy: 'integration-test',
      });
      await repository.assignComponent({
        scope: { tenantId, siteId }, device: oven, physicalDeviceId, componentKey: 'em1:1',
        role: 'Oven', assignedAt: observedAt, assignedBy: 'integration-test',
      });

      await repository.discoverLanIdentity({
        scope: { tenantId, siteId }, networkScope: 'gateway-home:iot',
        ipAddress: '192.168.1.204', macAddress: 'aa:bb:cc:dd:ee:ff', gatewayId: 'gateway-home',
        observedAt, evidenceSource: 'lan_discovery', associatedAt: observedAt,
        associatedBy: 'integration-test', device: boiler, physicalDeviceId,
      });
      await repository.refreshNetworkObservations({ tenantId, siteId }, [{
        physicalDeviceId,
        ipAddress: '192.168.1.219', macAddress: 'aa:bb:cc:dd:ee:ff', gatewayId: 'gateway-home',
        networkScope: 'gateway-home:iot', observedAt: '2026-10-19T12:15:00.000Z', evidenceSource: 'lan_discovery',
      }]);
      await expect(repository.refreshNetworkObservations({ tenantId, siteId }, [{
        physicalDeviceId: concurrentDiscoveries[0].physicalDeviceId,
        ipAddress: '192.168.1.220', macAddress: 'aa:bb:cc:dd:ee:ff', gatewayId: 'gateway-home',
        networkScope: 'gateway-home:iot', observedAt: '2026-10-19T12:16:00.000Z', evidenceSource: 'lan_discovery_protocol_match',
      }])).rejects.toThrow('already associated');

      const restartPool = await createVerifiedEnrollmentTestPool({ max: 1 });
      try {
        const restarted = new PostgresPhysicalDeviceInventoryRepository(restartPool);
        const persisted = await restarted.get({ tenantId, siteId }, physicalDeviceId);
        expect(persisted).toMatchObject({
          physicalDeviceId,
          components: [{ key: 'em1:0' }, { key: 'em1:1' }],
          endpoints: expect.arrayContaining([
            expect.objectContaining({ protocol: 'mqtt', kind: 'telemetry' }),
            expect.objectContaining({ protocol: 'http', kind: 'rpc' }),
          ]),
          assignments: expect.arrayContaining([
            expect.objectContaining({ deviceId: boiler.deviceId, componentKey: 'em1:0', role: 'Boiler' }),
            expect.objectContaining({ deviceId: oven.deviceId, componentKey: 'em1:1', role: 'Oven' }),
          ]),
        });
        const [boilerProjection, ovenProjection] = await Promise.all([
          restarted.forLogicalDevice({ tenantId, siteId }, boiler.deviceId),
          restarted.forLogicalDevice({ tenantId, siteId }, oven.deviceId),
        ]);
        expect(boilerProjection).toMatchObject({
          physicalDeviceId,
          assignments: expect.arrayContaining([expect.objectContaining({
            deviceId: boiler.deviceId, componentKey: 'em1:0', role: 'Boiler',
          })]),
          networkObservations: expect.arrayContaining([expect.objectContaining({
            ipAddress: '192.168.1.219', macAddress: 'aa:bb:cc:dd:ee:ff', isCurrent: true,
          })]),
        });
        expect(ovenProjection).toMatchObject({
          physicalDeviceId,
          assignments: expect.arrayContaining([expect.objectContaining({
            deviceId: oven.deviceId, componentKey: 'em1:1', role: 'Oven',
          })]),
          networkObservations: expect.arrayContaining([expect.objectContaining({
            ipAddress: '192.168.1.219', macAddress: 'aa:bb:cc:dd:ee:ff', isCurrent: true,
          })]),
        });
        expect(persisted?.networkObservations).toEqual(expect.arrayContaining([
          expect.objectContaining({ ipAddress: '192.168.1.204', isCurrent: false }),
          expect.objectContaining({ ipAddress: '192.168.1.219', isCurrent: true }),
        ]));
        expect(await restarted.list({ tenantId: `other-${runId}`, siteId })).toHaveLength(0);
      } finally {
        await restartPool.end();
      }

      const unrelated = await repository.discover({
        scope: { tenantId, siteId },
        identity: { namespace: 'mqtt:device-id', value: 'unrelated-meter' },
        evidenceSource: 'mqtt_protocol_message', observedAt,
        components: [{ key: 'meter', capabilities: ['power'] }],
      });
      await enrollment.enroll({ tenantId, siteId, deviceId: 'other-meter', displayName: 'Other meter' }, 'integration-test');
      await expect(repository.discoverLanIdentity({
        scope: { tenantId, siteId }, networkScope: 'gateway-home:iot',
        ipAddress: '192.168.1.220', macAddress: 'aa:bb:cc:dd:ee:ff', observedAt,
        evidenceSource: 'lan_discovery', associatedAt: observedAt, associatedBy: 'integration-test',
        device: { tenantId, siteId, deviceId: 'other-meter' }, physicalDeviceId: unrelated.physicalDeviceId,
      })).rejects.toThrow('already associated');
    } finally {
      await pool.query(`DELETE FROM device_inventory.logical_component_assignments WHERE tenant_id=$1 AND site_id = ANY($2::text[])`, [tenantId,[siteId,isolatedSiteId]]);
      await pool.query(`DELETE FROM device_inventory.physical_device_network_observations WHERE tenant_id=$1 AND site_id = ANY($2::text[])`, [tenantId,[siteId,isolatedSiteId]]);
      await pool.query(`DELETE FROM device_inventory.physical_device_endpoints WHERE tenant_id=$1 AND site_id = ANY($2::text[])`, [tenantId,[siteId,isolatedSiteId]]);
      await pool.query(`DELETE FROM device_inventory.physical_device_components WHERE tenant_id=$1 AND site_id = ANY($2::text[])`, [tenantId,[siteId,isolatedSiteId]]);
      await pool.query(`DELETE FROM device_inventory.physical_device_identity_claims WHERE tenant_id=$1 AND site_id = ANY($2::text[])`, [tenantId,[siteId,isolatedSiteId]]);
      await pool.query(`DELETE FROM device_inventory.physical_devices WHERE tenant_id=$1 AND site_id = ANY($2::text[])`, [tenantId,[siteId,isolatedSiteId]]);
      await pool.query(`DELETE FROM device_inventory.enrollment_events WHERE tenant_id=$1 AND site_id = ANY($2::text[])`, [tenantId,[siteId,isolatedSiteId]]);
      await pool.query(`DELETE FROM device_inventory.enrollments WHERE tenant_id=$1 AND site_id = ANY($2::text[])`, [tenantId,[siteId,isolatedSiteId]]);
      await pool.end();
    }
  }, 30000);
});
