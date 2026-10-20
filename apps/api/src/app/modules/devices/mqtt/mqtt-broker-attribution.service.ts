import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { connect, type MqttClient, type IClientOptions } from 'mqtt'
import { DeviceRegistryService } from '../device-registry.service'
import { DeviceDiscoveryMemoryStore } from '../device-discovery-memory.store'
import { configuredNetworkZoneForAddress } from '../device-lan-discovery.service'
import { isIPv4Address, readOnlyShellyDeviceInfo } from '../adapters/inbound/shelly/read-only-shelly-rpc'
import type { PhysicalDeviceInventoryService } from '../enrollment/physical-device-inventory.service'
import { PHYSICAL_DEVICE_INVENTORY_SERVICE } from '../enrollment/device-enrollment.module'
import type { PhysicalDeviceScope } from '../enrollment/physical-device-inventory.repository'
import {
  payloadSha256,
  verifyBrokerPublisherEvidence,
  type BrokerPublisherEvidenceV1,
} from './broker-publisher-evidence'
import type { NetworkDiscoveredDevice } from '../device-registry.types'

const evidenceTopic = 'energrid/broker-evidence/v1'
const cacheTtlMs = 30_000
const correlationSettleMs = 100
const maxPending = 256
const maxWorkQueue = 64
const maxCorrelatedObservationsPerKey = 16
const maxEvidenceEnvelopeBytes = 8192
const publisherEvidenceRetentionMs = 90 * 24 * 60 * 60 * 1000
const publisherEvidencePruneIntervalMs = 24 * 60 * 60 * 1000
export const MQTT_ATTRIBUTION_CONNECT_FACTORY = Symbol('MQTT_ATTRIBUTION_CONNECT_FACTORY')
export const MQTT_ATTRIBUTION_CLOCK = Symbol('MQTT_ATTRIBUTION_CLOCK')
type MqttConnectFactory = typeof connect

export interface ShellyMqttIdentityObservation {
  topic: string
  payloadText: string
  protocolId: string
  componentKeys: string[]
  physicalDeviceId: string
  observedAt: string
}

interface CorrelationBucket {
  events: BrokerPublisherEvidenceV1[]
  messages: ShellyMqttIdentityObservation[]
  expiresAt: number
  correlationTimer?: NodeJS.Timeout
}

interface PublisherAssociation {
  scope: PhysicalDeviceScope
  physicalDeviceId: string
  protocolId: string
  expiresAt: number
}

export interface BrokerAttributionOptions {
  enabled: boolean
  host: string
  port: number
  brokerId: string
  clientId: string
  hmacKey: string
  username?: string
  password?: string
}

export function brokerAttributionOptions(env: NodeJS.ProcessEnv): BrokerAttributionOptions | null {
  const enabled = env.HOME_MQTT_ATTRIBUTION_ENABLED === 'true'
  if (!enabled) return null
  const brokerId = env.HOME_MQTT_ATTRIBUTION_BROKER_ID?.trim()
  const clientId = env.HOME_MQTT_ATTRIBUTION_CLIENT_ID?.trim()
  const hmacKey = env.HOME_MQTT_ATTRIBUTION_HMAC_KEY?.trim()
  const host = env.HOME_MQTT_HOST || env.MQTT_HOST
  const port = Number(env.HOME_MQTT_PORT || env.MQTT_PORT || 1883)
  if (
    !host ||
    !brokerId ||
    !clientId ||
    !hmacKey ||
    hmacKey.length < 32 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('MQTT broker attribution requires broker ID, client ID, key, and valid broker address')
  }
  return {
    enabled,
    host,
    port,
    brokerId,
    clientId,
    hmacKey,
    username: env.HOME_MQTT_USERNAME,
    password: env.HOME_MQTT_PASSWORD,
  }
}

export function isPlausibleShellyLanCandidate(peerIp: string): boolean {
  if (!isIPv4Address(peerIp)) return false
  const [a, b] = peerIp.split('.').map(Number)
  const privateAddress = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  if (!privateAddress) return false
  const zone = configuredNetworkZoneForAddress(peerIp)
  return !!zone?.gatewayIps?.length
}

@Injectable()
export class MqttBrokerAttributionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttBrokerAttributionService.name)
  private readonly correlations = new Map<string, CorrelationBucket>()
  private readonly seenEvents = new Map<string, number>()
  private readonly pendingEvents = new Set<string>()
  private readonly eventScopes = new Map<string, PhysicalDeviceScope>()
  private readonly publisherAssociations = new Map<string, PublisherAssociation>()
  private client?: MqttClient
  private retentionTimer?: NodeJS.Timeout
  private readonly connectClient: MqttConnectFactory
  private options: BrokerAttributionOptions | null = null
  private workQueue: Array<() => Promise<void>> = []
  private runningWork = false

  constructor(
    private readonly registry: DeviceRegistryService,
    @Optional()
    @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly inventory?: PhysicalDeviceInventoryService,
    private readonly discoveryMemory?: DeviceDiscoveryMemoryStore,
    @Optional()
    @Inject(MQTT_ATTRIBUTION_CLOCK)
    private readonly now: () => number = Date.now,
    @Optional()
    @Inject(MQTT_ATTRIBUTION_CONNECT_FACTORY)
    connectClient?: MqttConnectFactory,
  ) {
    this.connectClient = connectClient ?? connect
  }

  onModuleInit(): void {
    this.options = brokerAttributionOptions(process.env)
    if (!this.options || !this.inventory || !this.discoveryMemory) return
    void this.pruneExpiredEvidence()
    this.retentionTimer = setInterval(() => void this.pruneExpiredEvidence(), publisherEvidencePruneIntervalMs)
    this.retentionTimer.unref()
    const options: IClientOptions = {
      host: this.options.host,
      port: this.options.port,
      protocol: process.env.HOME_MQTT_TLS === 'true' ? 'mqtts' : 'mqtt',
      username: this.options.username,
      password: this.options.password,
      clientId: this.options.clientId,
      clean: false,
      protocolVersion: 4,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      resubscribe: false,
    }
    const client = (this.client = this.connectClient(options))
    client.handleMessage = (packet, done) => {
      void this.acceptEvidence(packet.payload.toString('utf8')).then(
        () => done(),
        () => done(new Error('Broker evidence could not be accepted')),
      )
    }
    client.on('connect', () => {
      client.subscribe(evidenceTopic, { qos: 1 }, (error, granted) => {
        if (error || granted?.length !== 1 || granted[0].qos !== 1) {
          this.logger.error('Broker evidence subscription requires QoS 1; attribution is paused.')
        }
      })
    })
    client.on('error', () => this.logger.warn('Broker attribution subscriber connection failed.'))
  }

  async onModuleDestroy(): Promise<void> {
    if (this.retentionTimer) clearInterval(this.retentionTimer)
    for (const key of this.correlations.keys()) this.clearCorrelation(key)
    if (this.client) await new Promise<void>((resolve) => this.client!.end(true, {}, () => resolve()))
  }

  async acceptEvidence(payloadText: string): Promise<void> {
    if (Buffer.byteLength(payloadText, 'utf8') > maxEvidenceEnvelopeBytes) return
    const options = this.options ?? brokerAttributionOptions(process.env)
    if (!options) return
    this.options = options
    let parsed: unknown
    try {
      parsed = JSON.parse(payloadText)
    } catch {
      return
    }
    const event = verifyBrokerPublisherEvidence(parsed, options.hmacKey, options.brokerId, this.now())
    if (
      !event ||
      this.seenEvents.has(event.eventId) ||
      this.pendingEvents.has(event.eventId) ||
      this.pendingEvents.size >= maxPending * 4
    )
      return

    this.pendingEvents.add(event.eventId)
    try {
      if (event.kind === 'disconnect') {
        await this.handleDisconnect(event)
        this.markSeen(event.eventId)
        return
      }
      if (!this.inventory || !this.discoveryMemory) return

      // Persist the signed broker observation before acknowledging its QoS 1 delivery.
      // It remains explicitly unmatched until topic+payload evidence identifies a Shelly.
      const scope = this.currentScope()
      const inserted = await this.inventory.recordMqttPublisherEvidence(scope, {
        eventId: event.eventId,
        brokerId: event.brokerId,
        clientId: event.clientId,
        peerIp: event.peerIp,
        publishedTopic: event.topic,
        payloadSha256: event.payloadSha256,
        observedAt: event.observedAt,
        connectionState: 'connected',
        identityVerification: 'unmatched',
      })
      if (!inserted) {
        this.markSeen(event.eventId)
        return
      }
      this.eventScopes.set(event.eventId, scope)
      this.markSeen(event.eventId)
      const key = correlationKey(event.topic!, event.payloadSha256!)
      const bucket = this.getBucket(key)
      if (bucket.events.length < maxCorrelatedObservationsPerKey) bucket.events.push(event)
      this.tryCorrelate(key, bucket)
    } finally {
      this.pendingEvents.delete(event.eventId)
    }
  }

  observeShellyMessage(observation: ShellyMqttIdentityObservation): void {
    if (
      !this.options ||
      !this.inventory ||
      !this.discoveryMemory ||
      !observation.protocolId ||
      !observation.physicalDeviceId ||
      !observation.componentKeys.length
    )
      return
    const key = correlationKey(observation.topic, payloadSha256(observation.payloadText))
    const bucket = this.getBucket(key)
    if (bucket.messages.length < maxCorrelatedObservationsPerKey) bucket.messages.push(observation)
    this.tryCorrelate(key, bucket)
  }

  private tryCorrelate(key: string, bucket: CorrelationBucket): void {
    if (!bucket.events.length || !bucket.messages.length) return
    if (bucket.correlationTimer) return
    bucket.correlationTimer = setTimeout(() => {
      bucket.correlationTimer = undefined
      if (this.correlations.get(key) === bucket) this.correlate(key, bucket)
    }, correlationSettleMs)
    bucket.correlationTimer.unref()
  }

  private correlate(key: string, bucket: CorrelationBucket): void {
    if (!bucket.events.length || !bucket.messages.length) return
    const publishers = new Set(bucket.events.map((event) => `${event.clientId}\u0000${event.peerIp}`))
    const physicalIdentities = new Set(
      bucket.messages.map((message) => `${message.physicalDeviceId}\u0000${message.protocolId.toLowerCase()}`),
    )
    if (publishers.size !== 1 || physicalIdentities.size !== 1) return
    bucket.events.sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    bucket.messages.sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    const event = bucket.events.shift()!
    const message = bucket.messages.shift()!
    if (Math.abs(Date.parse(event.observedAt) - Date.parse(message.observedAt)) > cacheTtlMs) return
    if (!bucket.events.length && !bucket.messages.length) this.clearCorrelation(key)
    const connectionKey = publisherKey(event)
    const scope = this.eventScopes.get(event.eventId)
    if (!scope) return
    this.publisherAssociations.set(connectionKey, {
      scope,
      physicalDeviceId: message.physicalDeviceId,
      protocolId: message.protocolId,
      expiresAt: this.now() + 10 * 60_000,
    })
    this.pruneCaches()
    this.enqueue(async () => this.persistAndInvestigate(event, message, scope))
  }

  private async persistAndInvestigate(
    event: BrokerPublisherEvidenceV1,
    message: ShellyMqttIdentityObservation,
    scope: PhysicalDeviceScope,
  ): Promise<void> {
    if (!this.inventory || !this.discoveryMemory) return
    await this.inventory.associateMqttPublisherEvidence(
      scope,
      event.brokerId,
      event.eventId,
      message.physicalDeviceId,
      message.protocolId,
    )

    const zone = isPlausibleShellyLanCandidate(event.peerIp) ? configuredNetworkZoneForAddress(event.peerIp) : null
    if (!zone) {
      await this.inventory.updateMqttPublisherIdentityVerification(
        scope,
        event.brokerId,
        event.eventId,
        'not_plausible',
      )
      return
    }

    const rpc = await readOnlyShellyDeviceInfo(event.peerIp)
    if (!rpc) {
      await this.inventory.updateMqttPublisherIdentityVerification(
        scope,
        event.brokerId,
        event.eventId,
        'rpc_unreachable',
      )
      return
    }
    if (rpc.id?.toLowerCase() !== message.protocolId.toLowerCase()) {
      await this.inventory.updateMqttPublisherIdentityVerification(scope, event.brokerId, event.eventId, 'rpc_mismatch')
      return
    }

    const verifiedAt = new Date(this.now()).toISOString()
    await this.inventory.updateMqttPublisherIdentityVerification(
      scope,
      event.brokerId,
      event.eventId,
      'rpc_verified',
      event.peerIp,
    )
    await this.inventory.refreshNetworkObservations(scope, [
      {
        physicalDeviceId: message.physicalDeviceId,
        ipAddress: event.peerIp,
        networkScope: `gateway-unknown:${zone.id}`,
        observedAt: verifiedAt,
        evidenceSource: 'mqtt_broker_publisher_attribution_exact_shelly_rpc',
      },
    ])
    const device: NetworkDiscoveredDevice = {
      id: message.protocolId,
      ipAddress: event.peerIp,
      networkZoneId: zone.id,
      networkZoneName: zone.name,
      vendor: 'Shelly',
      protocol: 'http',
      confidence: 0.95,
      status: 'online',
      discoveredAt: verifiedAt,
      reason: 'Verified through broker publisher attribution and exact Shelly RPC identity.',
      ...(rpc.model ? { model: rpc.model } : {}),
      ...(rpc.app ? { app: rpc.app } : {}),
      ...(rpc.gen ? { generation: rpc.gen } : {}),
      ...(rpc.firmware ? { firmwareVersion: rpc.firmware } : {}),
      ...(rpc.mac ? { deviceReportedMacAddress: rpc.mac } : {}),
      components: message.componentKeys.map((component) => ({
        component,
        channel: Number(component.split(':')[1]),
      })),
      endpoints: [
        {
          ipAddress: event.peerIp,
          networkZoneId: zone.id,
          networkZoneName: zone.name,
        },
      ],
    }
    await this.discoveryMemory.recordIdentityObservation(verifiedAt, device)
  }

  private async handleDisconnect(event: BrokerPublisherEvidenceV1): Promise<boolean> {
    if (!this.inventory) return false
    const key = publisherKey(event)
    const association = this.publisherAssociations.get(key)
    const currentAssociation = association && association.expiresAt >= this.now() ? association : undefined
    const inserted = await this.inventory.recordMqttPublisherEvidence(
      currentAssociation?.scope ?? this.currentScope(),
      {
        eventId: event.eventId,
        ...(currentAssociation
          ? {
              physicalDeviceId: currentAssociation.physicalDeviceId,
              shellyProtocolId: currentAssociation.protocolId,
              identityVerification: 'publisher_observed' as const,
            }
          : { identityVerification: 'unmatched' as const }),
        brokerId: event.brokerId,
        clientId: event.clientId,
        peerIp: event.peerIp,
        publishedTopic: null,
        payloadSha256: null,
        observedAt: event.observedAt,
        connectionState: 'disconnected',
      },
    )
    if (association) this.publisherAssociations.delete(key)
    return inserted
  }

  private currentScope(): PhysicalDeviceScope {
    const { tenant, site } = this.registry.getSnapshot()
    return { tenantId: tenant.id, siteId: site.id }
  }

  private async pruneExpiredEvidence(): Promise<void> {
    if (!this.inventory) return
    try {
      const before = new Date(this.now() - publisherEvidenceRetentionMs).toISOString()
      await this.inventory.pruneMqttPublisherEvidence(this.currentScope(), before)
    } catch {
      this.logger.warn('Broker evidence retention cleanup failed.')
    }
  }

  private getBucket(key: string): CorrelationBucket {
    let bucket = this.correlations.get(key)
    if (bucket && bucket.expiresAt < this.now()) {
      this.clearCorrelation(key)
      bucket = undefined
    }
    if (!bucket) {
      this.pruneCaches()
      if (this.correlations.size >= maxPending) {
        this.clearCorrelation(this.correlations.keys().next().value!)
      }
      bucket = { events: [], messages: [], expiresAt: this.now() + cacheTtlMs }
      this.correlations.set(key, bucket)
    }
    return bucket
  }

  private pruneCaches(): void {
    const now = this.now()
    for (const [key, value] of this.correlations) if (value.expiresAt < now) this.clearCorrelation(key)
    for (const [key, expiresAt] of this.seenEvents) if (expiresAt < now) this.seenEvents.delete(key)
    for (const key of this.eventScopes.keys()) if (!this.seenEvents.has(key)) this.eventScopes.delete(key)
    for (const [key, value] of this.publisherAssociations)
      if (value.expiresAt < now) this.publisherAssociations.delete(key)
    while (this.correlations.size > maxPending) this.clearCorrelation(this.correlations.keys().next().value!)
    while (this.seenEvents.size > maxPending * 4) this.seenEvents.delete(this.seenEvents.keys().next().value!)
    while (this.publisherAssociations.size > maxPending) {
      this.publisherAssociations.delete(this.publisherAssociations.keys().next().value!)
    }
  }

  private clearCorrelation(key: string): void {
    const bucket = this.correlations.get(key)
    if (bucket?.correlationTimer) clearTimeout(bucket.correlationTimer)
    this.correlations.delete(key)
  }

  private markSeen(eventId: string): void {
    this.seenEvents.set(eventId, this.now() + cacheTtlMs)
    this.pruneCaches()
  }

  private enqueue(work: () => Promise<void>): void {
    if (this.workQueue.length >= maxWorkQueue) {
      this.logger.warn('Broker identity work queue is full; attribution was not promoted.')
      return
    }
    this.workQueue.push(work)
    if (!this.runningWork) void this.runWorkQueue()
  }

  private async runWorkQueue(): Promise<void> {
    this.runningWork = true
    try {
      while (this.workQueue.length) {
        const work = this.workQueue.shift()!
        try {
          await work()
        } catch {
          this.logger.warn('Broker-attributed Shelly evidence persistence failed.')
        }
      }
    } finally {
      this.runningWork = false
    }
  }
}

function correlationKey(topic: string, hash: string): string {
  return `${topic}\u0000${hash.toLowerCase()}`
}

function publisherKey(event: Pick<BrokerPublisherEvidenceV1, 'brokerId' | 'clientId' | 'peerIp'>): string {
  return `${event.brokerId}\u0000${event.clientId}\u0000${event.peerIp}`
}
