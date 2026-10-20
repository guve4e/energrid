import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  LogicalComponentAssignment,
  PhysicalDeviceDiscovery,
  PhysicalDeviceInventoryRecord,
  PhysicalDeviceInventoryRepository,
  PhysicalDeviceNetworkObservation,
  PhysicalDeviceScope,
  PhysicalLanObservation,
  MqttPublisherEvidence,
  MqttPublisherEvidenceRecord,
  MqttPublisherIdentityVerification,
} from './physical-device-inventory.repository';

type PhysicalRow = {
  tenant_id: string; site_id: string; physical_device_id: string;
  vendor: string | null; hardware_model: string | null; firmware_version: string | null;
  first_seen_at: Date | string; last_seen_at: Date | string;
};
const iso = (value: Date | string) => new Date(value).toISOString();
const uniqueViolation = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === '23505';

export class PostgresPhysicalDeviceInventoryRepository implements PhysicalDeviceInventoryRepository {
  constructor(private readonly pool: Pool) {}

  async discover(input: PhysicalDeviceDiscovery): Promise<PhysicalDeviceInventoryRecord> {
    let physicalDeviceId: string;
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const prior = await client.query<PhysicalRow>(
          `SELECT p.* FROM device_inventory.physical_device_identity_claims c
           JOIN device_inventory.physical_devices p USING (tenant_id, site_id, physical_device_id)
           WHERE c.tenant_id=$1 AND c.site_id=$2 AND c.identity_scope=''
             AND c.identity_namespace=$3 AND lower(c.identity_value)=lower($4)
             AND c.is_current=TRUE FOR UPDATE OF p`,
          [input.scope.tenantId, input.scope.siteId, input.identity.namespace, input.identity.value],
        );
        physicalDeviceId = input.physicalDeviceId || prior.rows[0]?.physical_device_id || '';
        if (input.physicalDeviceId) {
          if (prior.rows[0] && prior.rows[0].physical_device_id !== input.physicalDeviceId) {
            throw new Error('Physical identity is already associated with another device');
          }
          const exists = await client.query(
            `SELECT 1 FROM device_inventory.physical_devices
             WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 FOR UPDATE`,
            [input.scope.tenantId,input.scope.siteId,input.physicalDeviceId],
          );
          if (!exists.rowCount) throw new Error('Physical device was not found');
        }
        if (!physicalDeviceId) {
          physicalDeviceId = randomUUID();
          await client.query(
            `INSERT INTO device_inventory.physical_devices
             (tenant_id,site_id,physical_device_id,vendor,hardware_model,firmware_version,first_seen_at,last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
            [input.scope.tenantId, input.scope.siteId, physicalDeviceId, input.vendor ?? null,
              input.hardwareModel ?? null, input.firmwareVersion ?? null, input.observedAt],
          );
        }
        if (!prior.rows[0]) {
          await client.query(
            `INSERT INTO device_inventory.physical_device_identity_claims
             (id,tenant_id,site_id,physical_device_id,identity_namespace,identity_value,
              evidence_source,verification_status,first_seen_at,last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'protocol_observed',$8,$8)`,
            [randomUUID(), input.scope.tenantId, input.scope.siteId, physicalDeviceId,
              input.identity.namespace, input.identity.value, input.evidenceSource, input.observedAt],
          );
        } else {
          await client.query(
            `UPDATE device_inventory.physical_device_identity_claims
             SET last_seen_at=GREATEST(last_seen_at,$5::timestamptz)
             WHERE tenant_id=$1 AND site_id=$2 AND identity_scope=''
               AND identity_namespace=$3 AND lower(identity_value)=lower($4) AND is_current=TRUE`,
            [input.scope.tenantId, input.scope.siteId, input.identity.namespace,
              input.identity.value, input.observedAt],
          );
        }
        await client.query(
          `UPDATE device_inventory.physical_devices SET
             vendor=COALESCE($4,vendor), hardware_model=COALESCE($5,hardware_model),
             firmware_version=COALESCE($6,firmware_version),
             last_seen_at=GREATEST(last_seen_at,$7::timestamptz)
           WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3`,
          [input.scope.tenantId, input.scope.siteId, physicalDeviceId, input.vendor ?? null,
            input.hardwareModel ?? null, input.firmwareVersion ?? null, input.observedAt],
        );

        for (const component of input.components) {
          await client.query(
            `INSERT INTO device_inventory.physical_device_components
             (tenant_id,site_id,physical_device_id,component_key,capabilities,first_seen_at,last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$6)
             ON CONFLICT (tenant_id,site_id,physical_device_id,component_key) DO UPDATE
             SET capabilities=ARRAY(SELECT DISTINCT unnest(
                 device_inventory.physical_device_components.capabilities || EXCLUDED.capabilities)),
                 last_seen_at=GREATEST(device_inventory.physical_device_components.last_seen_at,EXCLUDED.last_seen_at)`,
            [input.scope.tenantId, input.scope.siteId, physicalDeviceId,
              component.key, component.capabilities, input.observedAt],
          );
        }
        if (input.endpoint) {
          await client.query(
            `INSERT INTO device_inventory.physical_device_endpoints AS current_endpoint
             (tenant_id,site_id,physical_device_id,protocol,endpoint_kind,address,last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (tenant_id,site_id,physical_device_id,protocol,endpoint_kind)
             DO UPDATE SET address=EXCLUDED.address,last_seen_at=EXCLUDED.last_seen_at
             -- For equal timestamps, the C-collation greatest address wins.
             WHERE EXCLUDED.last_seen_at > current_endpoint.last_seen_at
               OR (EXCLUDED.last_seen_at = current_endpoint.last_seen_at
                 AND EXCLUDED.address COLLATE "C" > current_endpoint.address COLLATE "C")`,
            [input.scope.tenantId, input.scope.siteId, physicalDeviceId,
              input.endpoint.protocol, input.endpoint.kind, input.endpoint.address, input.observedAt],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (uniqueViolation(error)) throw new Error('Physical identity is already associated with another device');
      throw error;
    }
    // Release the transaction client before readback. `get()` needs pool capacity;
    // holding this client here can deadlock all three slots under concurrent MQTT discovery.
    return (await this.get(input.scope, physicalDeviceId))!;
  }

  async discoverLanIdentity(input: Parameters<PhysicalDeviceInventoryRepository['discoverLanIdentity']>[0]) {
    let physicalDeviceId: string;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const assignment = await client.query<{ physical_device_id: string }>(
        `SELECT physical_device_id FROM device_inventory.logical_component_assignments
         WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3 FOR UPDATE`,
        [input.scope.tenantId, input.scope.siteId, input.device.deviceId],
      );
      if (input.physicalDeviceId && assignment.rows[0]?.physical_device_id &&
        assignment.rows[0].physical_device_id !== input.physicalDeviceId) {
        throw new Error('Logical device is already assigned to another physical device');
      }
      physicalDeviceId = input.physicalDeviceId || assignment.rows[0]?.physical_device_id || '';
      if (input.physicalDeviceId) {
        const exists = await client.query(
          `SELECT 1 FROM device_inventory.physical_devices
           WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 FOR UPDATE`,
          [input.scope.tenantId,input.scope.siteId,input.physicalDeviceId],
        );
        if (!exists.rowCount) throw new Error('Physical device was not found');
      }
      if (!physicalDeviceId) {
        physicalDeviceId = randomUUID();
        await client.query(
          `INSERT INTO device_inventory.physical_devices
           (tenant_id,site_id,physical_device_id,vendor,hardware_model,firmware_version,first_seen_at,last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
          [input.scope.tenantId, input.scope.siteId, physicalDeviceId, input.vendor ?? null,
            input.hardwareModel ?? null, input.firmwareVersion ?? null, input.observedAt],
        );
      }
      if (input.macAddress) {
        await client.query(
          `INSERT INTO device_inventory.physical_device_identity_claims
           (id,tenant_id,site_id,physical_device_id,identity_namespace,identity_value,
            identity_scope,evidence_source,verification_status,first_seen_at,last_seen_at,
            associated_at,associated_by)
           VALUES ($1,$2,$3,$4,'mac',$5,$6,$7,'user_confirmed',$8,$8,$9,$10)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), input.scope.tenantId, input.scope.siteId, physicalDeviceId,
            input.macAddress.toLowerCase(), input.networkScope, input.evidenceSource,
            input.observedAt, input.associatedAt, input.associatedBy],
        );
      }
      await client.query(`UPDATE device_inventory.physical_devices SET
        vendor=COALESCE($4,vendor),hardware_model=COALESCE($5,hardware_model),
        firmware_version=COALESCE($6,firmware_version),last_seen_at=GREATEST(last_seen_at,$7::timestamptz)
        WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3`,
      [input.scope.tenantId,input.scope.siteId,physicalDeviceId,input.vendor ?? null,
        input.hardwareModel ?? null,input.firmwareVersion ?? null,input.observedAt]);
      await client.query(
        `UPDATE device_inventory.physical_device_network_observations SET is_current=FALSE
         WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 AND network_scope=$4 AND is_current=TRUE`,
        [input.scope.tenantId, input.scope.siteId, physicalDeviceId, input.networkScope],
      );
      await client.query(
        `INSERT INTO device_inventory.physical_device_network_observations
         (id,tenant_id,site_id,physical_device_id,ip_address,mac_address,hostname,gateway_id,
          network_scope,observed_at,evidence_source,verification_status,associated_at,associated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'user_confirmed',$12,$13)`,
        [randomUUID(), input.scope.tenantId, input.scope.siteId, physicalDeviceId,
          input.ipAddress, input.macAddress?.toLowerCase() ?? null, input.hostname ?? null,
          input.gatewayId ?? null, input.networkScope, input.observedAt,
          input.evidenceSource, input.associatedAt, input.associatedBy],
      );
      if (assignment.rows[0] && assignment.rows[0].physical_device_id !== physicalDeviceId) {
        throw new Error('Logical device is already assigned to another physical device');
      }
      await client.query(
        `INSERT INTO device_inventory.logical_component_assignments
         (tenant_id,site_id,device_id,physical_device_id,assigned_at,assigned_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id,site_id,device_id) DO NOTHING`,
        [input.scope.tenantId, input.scope.siteId, input.device.deviceId,
          physicalDeviceId, input.associatedAt, input.associatedBy],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (uniqueViolation(error)) throw new Error('Network MAC identity is already associated with another physical device');
      throw error;
    } finally {
      client.release();
    }
    return (await this.get(input.scope, physicalDeviceId))!;
  }

  async assignComponent(input: Parameters<PhysicalDeviceInventoryRepository['assignComponent']>[0]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO device_inventory.logical_component_assignments
         (tenant_id,site_id,device_id,physical_device_id,component_key,logical_role,assigned_at,assigned_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id,site_id,device_id) DO UPDATE SET
           logical_role=EXCLUDED.logical_role,assigned_at=EXCLUDED.assigned_at,assigned_by=EXCLUDED.assigned_by
         WHERE device_inventory.logical_component_assignments.physical_device_id=EXCLUDED.physical_device_id
           AND (device_inventory.logical_component_assignments.component_key IS NOT DISTINCT FROM EXCLUDED.component_key
             OR device_inventory.logical_component_assignments.component_key IS NULL)
         RETURNING physical_device_id`,
        [input.scope.tenantId,input.scope.siteId,input.device.deviceId,input.physicalDeviceId,
          input.componentKey ?? null,input.role ?? null,input.assignedAt,input.assignedBy],
      );
      if (!result.rowCount) throw new Error('Logical device is already assigned to another physical component');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (uniqueViolation(error)) throw new Error('Physical component is already assigned to another logical device');
      throw error;
    } finally {
      client.release();
    }
    const record = await this.get(input.scope, input.physicalDeviceId);
    if (!record) throw new Error('Physical device was not found');
    return record;
  }

  async refreshNetworkObservations(scope: PhysicalDeviceScope, observations: PhysicalLanObservation[]): Promise<void> {
    for (const observation of observations) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        if (observation.macAddress) {
          const conflict = await client.query<{ physical_device_id: string }>(
            `SELECT physical_device_id
             FROM device_inventory.physical_device_network_observations
             WHERE tenant_id=$1 AND site_id=$2 AND network_scope=$3
               AND lower(mac_address)=lower($4) AND is_current=TRUE
             FOR UPDATE`,
            [scope.tenantId, scope.siteId, observation.networkScope, observation.macAddress],
          );
          if (conflict.rows[0] && conflict.rows[0].physical_device_id !== observation.physicalDeviceId) {
            throw new Error('Network MAC identity is already associated with another physical device');
          }
        }
        const current = await client.query(`SELECT * FROM device_inventory.physical_device_network_observations
          WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 AND network_scope=$4
            AND is_current=TRUE FOR UPDATE`,
        [scope.tenantId,scope.siteId,observation.physicalDeviceId,observation.networkScope]);
        const latest = current.rows[0];
        if (latest && Date.parse(observation.observedAt) <= Date.parse(iso(latest.observed_at))) {
          await client.query('ROLLBACK');
          continue;
        }
        if (latest) {
          await client.query('UPDATE device_inventory.physical_device_network_observations SET is_current=FALSE WHERE id=$1',[latest.id]);
        }
        await client.query(`INSERT INTO device_inventory.physical_device_network_observations
          (id,tenant_id,site_id,physical_device_id,ip_address,mac_address,hostname,gateway_id,
           network_scope,observed_at,evidence_source,verification_status,associated_at,associated_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [randomUUID(),scope.tenantId,scope.siteId,observation.physicalDeviceId,observation.ipAddress,
          observation.macAddress?.toLowerCase() ?? null,observation.hostname ?? null,observation.gatewayId ?? null,
          observation.networkScope,observation.observedAt,observation.evidenceSource,
          latest?.verification_status ?? 'protocol_observed',latest?.associated_at ?? null,latest?.associated_by ?? null]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (uniqueViolation(error)) {
          throw new Error('Network MAC identity is already associated with another physical device');
        }
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async recordMqttPublisherEvidence(scope: PhysicalDeviceScope, evidence: MqttPublisherEvidence): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO device_inventory.mqtt_publisher_evidence
        (tenant_id,site_id,event_id,physical_device_id,shelly_protocol_id,broker_id,
         client_id,peer_ip,published_topic,payload_sha256,observed_at,connection_state,identity_verification)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::inet,$9,$10,$11,$12,$13)
       ON CONFLICT (tenant_id,site_id,broker_id,event_id) DO NOTHING
       RETURNING event_id`,
      [scope.tenantId, scope.siteId, evidence.eventId, evidence.physicalDeviceId,
        evidence.shellyProtocolId, evidence.brokerId, evidence.clientId, evidence.peerIp,
        evidence.publishedTopic, evidence.payloadSha256, evidence.observedAt, evidence.connectionState,
        evidence.identityVerification ?? (evidence.physicalDeviceId ? 'publisher_observed' : 'unmatched')],
    );
    return result.rowCount === 1;
  }

  async associateMqttPublisherEvidence(
    scope: PhysicalDeviceScope,
    brokerId: string,
    eventId: string,
    physicalDeviceId: string,
    shellyProtocolId: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE device_inventory.mqtt_publisher_evidence
       SET physical_device_id=$5, shelly_protocol_id=$6, identity_verification='publisher_observed'
       WHERE tenant_id=$1 AND site_id=$2 AND broker_id=$3 AND event_id=$4
         AND identity_verification='unmatched'`,
      [scope.tenantId, scope.siteId, brokerId, eventId, physicalDeviceId, shellyProtocolId],
    );
    if (!result.rowCount) {
      const existing = await this.pool.query(
        `SELECT 1 FROM device_inventory.mqtt_publisher_evidence
         WHERE tenant_id=$1 AND site_id=$2 AND broker_id=$3 AND event_id=$4
           AND physical_device_id=$5 AND shelly_protocol_id=$6`,
        [scope.tenantId, scope.siteId, brokerId, eventId, physicalDeviceId, shellyProtocolId],
      );
      if (!existing.rowCount) throw new Error('Unmatched MQTT publisher evidence was not found');
    }
  }

  async updateMqttPublisherIdentityVerification(
    scope: PhysicalDeviceScope,
    brokerId: string,
    eventId: string,
    verification: MqttPublisherIdentityVerification,
    verifiedLanIp?: string,
  ): Promise<void> {
    if ((verification === 'rpc_verified') !== Boolean(verifiedLanIp)) {
      throw new Error('Verified LAN address must match the RPC verification result');
    }
    const result = await this.pool.query(
      `UPDATE device_inventory.mqtt_publisher_evidence
       SET identity_verification=$5, verified_lan_ip=$6::inet
       WHERE tenant_id=$1 AND site_id=$2 AND broker_id=$3 AND event_id=$4`,
      [scope.tenantId, scope.siteId, brokerId, eventId, verification, verifiedLanIp ?? null],
    );
    if (!result.rowCount) throw new Error('MQTT publisher evidence was not found');
  }

  async listRecentMqttPublisherEvidence(scope: PhysicalDeviceScope): Promise<MqttPublisherEvidenceRecord[]> {
    const result = await this.pool.query<{
      physical_device_id: string | null;
      shelly_protocol_id: string | null;
      broker_id: string;
      client_id: string;
      peer_ip: string;
      observed_at: Date | string;
      connection_state: 'connected' | 'disconnected';
      identity_verification: MqttPublisherEvidenceRecord['identityVerification'];
    }>(
      `SELECT physical_device_id,shelly_protocol_id,broker_id,client_id,peer_ip::text,
              observed_at,connection_state,identity_verification
       FROM device_inventory.mqtt_publisher_evidence
       WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id IS NOT NULL
         AND observed_at >= NOW() - INTERVAL '90 days'
       ORDER BY observed_at DESC LIMIT 5000`,
      [scope.tenantId, scope.siteId],
    );
    return result.rows.map(row => ({
      physicalDeviceId: row.physical_device_id,
      shellyProtocolId: row.shelly_protocol_id,
      brokerId: row.broker_id,
      clientId: row.client_id,
      peerIp: row.peer_ip,
      observedAt: iso(row.observed_at),
      connectionState: row.connection_state,
      identityVerification: row.identity_verification,
    }));
  }

  async pruneMqttPublisherEvidence(scope: PhysicalDeviceScope, olderThan: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM device_inventory.mqtt_publisher_evidence
       WHERE tenant_id=$1 AND site_id=$2 AND observed_at < $3::timestamptz`,
      [scope.tenantId, scope.siteId, olderThan],
    );
  }

  async get(scope: PhysicalDeviceScope, physicalDeviceId: string) {
    const rows = await this.pool.query<PhysicalRow>(
      `SELECT * FROM device_inventory.physical_devices
       WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3`,
      [scope.tenantId, scope.siteId, physicalDeviceId],
    );
    return rows.rows[0] ? this.mapRecord(rows.rows[0]) : null;
  }

  async forLogicalDevice(scope: PhysicalDeviceScope, deviceId: string) {
    const rows = await this.pool.query<{ physical_device_id: string }>(
      `SELECT physical_device_id FROM device_inventory.logical_component_assignments
       WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3`,
      [scope.tenantId, scope.siteId, deviceId],
    );
    return rows.rows[0] ? this.get(scope, rows.rows[0].physical_device_id) : null;
  }

  async list(scope: PhysicalDeviceScope) {
    const rows = await this.pool.query<PhysicalRow>(
      `SELECT * FROM device_inventory.physical_devices WHERE tenant_id=$1 AND site_id=$2
       ORDER BY first_seen_at, physical_device_id`,
      [scope.tenantId, scope.siteId],
    );
    return Promise.all(rows.rows.map(row => this.mapRecord(row)));
  }

  private async mapRecord(row: PhysicalRow): Promise<PhysicalDeviceInventoryRecord> {
    const scope = { tenantId: row.tenant_id, siteId: row.site_id };
    const [claims, components, endpoints, observations, assignments] = await Promise.all([
      this.pool.query(`SELECT * FROM device_inventory.physical_device_identity_claims
        WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 AND is_current=TRUE ORDER BY identity_namespace`,
      [scope.tenantId,scope.siteId,row.physical_device_id]),
      this.pool.query(`SELECT * FROM device_inventory.physical_device_components
        WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 ORDER BY component_key`,
      [scope.tenantId,scope.siteId,row.physical_device_id]),
      this.pool.query(`SELECT * FROM device_inventory.physical_device_endpoints
        WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 ORDER BY protocol,endpoint_kind`,
      [scope.tenantId,scope.siteId,row.physical_device_id]),
      this.pool.query(`SELECT * FROM device_inventory.physical_device_network_observations
        WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 ORDER BY observed_at DESC,id DESC`,
      [scope.tenantId,scope.siteId,row.physical_device_id]),
      this.pool.query(`SELECT * FROM device_inventory.logical_component_assignments
        WHERE tenant_id=$1 AND site_id=$2 AND physical_device_id=$3 ORDER BY device_id`,
      [scope.tenantId,scope.siteId,row.physical_device_id]),
    ]);
    const claim = claims.rows[0];
    const claimStatus = claims.rows.some(value => value.verification_status === 'hardware_verified')
      ? 'hardware_verified'
      : claims.rows.some(value => value.verification_status === 'user_confirmed')
        ? 'user_confirmed' : claim ? 'protocol_observed' : 'not_identified';
    return {
      physicalDeviceId: row.physical_device_id,
      scope,
      ...(claim ? { identity: { namespace: claim.identity_namespace, value: claim.identity_value } } : {}),
      ...(claim ? { identityEvidenceSource: claim.evidence_source, identityLastObservedAt: iso(claim.last_seen_at) } : {}),
      ...(row.vendor ? { vendor: row.vendor } : {}),
      ...(row.hardware_model ? { hardwareModel: row.hardware_model } : {}),
      ...(row.firmware_version ? { firmwareVersion: row.firmware_version } : {}),
      verificationStatus: claimStatus,
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      components: components.rows.map(value => ({ key: value.component_key,
        capabilities: value.capabilities, firstSeenAt: iso(value.first_seen_at), lastSeenAt: iso(value.last_seen_at) })),
      endpoints: endpoints.rows.map(value => ({ protocol: value.protocol, kind: value.endpoint_kind,
        address: value.address, lastSeenAt: iso(value.last_seen_at) })),
      networkObservations: observations.rows.map(value => ({ id: value.id, physicalDeviceId: value.physical_device_id,
        ipAddress: value.ip_address, ...(value.mac_address ? { macAddress: value.mac_address } : {}),
        ...(value.hostname ? { hostname: value.hostname } : {}), ...(value.gateway_id ? { gatewayId: value.gateway_id } : {}),
        networkScope: value.network_scope, observedAt: iso(value.observed_at), evidenceSource: value.evidence_source,
        verificationStatus: value.verification_status, associatedAt: value.associated_at ? iso(value.associated_at) : null,
        associatedBy: value.associated_by ?? null,
        isCurrent: value.is_current })) as PhysicalDeviceNetworkObservation[],
      assignments: assignments.rows.map(value => ({ deviceId: value.device_id,
        physicalDeviceId: value.physical_device_id, ...(value.component_key ? { componentKey: value.component_key } : {}),
        ...(value.logical_role ? { role: value.logical_role } : {}), assignedAt: iso(value.assigned_at),
        assignedBy: value.assigned_by })) as LogicalComponentAssignment[],
    };
  }
}
