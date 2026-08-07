const http = require('node:http')
const { readFile } = require('node:fs/promises')
const { extname, join, normalize } = require('node:path')

const { devices: configuredDevices } = require('./device-lab.config')
const { createRuntimeDevice } = require('./device-lab-device')
const { DeviceLabService } = require('./application/device-lab.service')
const { MqttPublisher } = require('./infrastructure/mqtt-publisher')
const {
  MqttCommandSubscriber,
} = require('./infrastructure/mqtt-command-subscriber')
const {
  DeviceLabRegistryAnnouncer,
} = require('./infrastructure/device-lab-registry-announcer')
const {
  SimulatorRegistry,
} = require('./infrastructure/simulator-registry')
const {
  MqttDeviceSimulator,
} = require('./simulators/mqtt-device.simulator')
const {
  HttpDeviceSimulator,
} = require('./simulators/http-device.simulator')
const {
  ZigbeeDeviceSimulator,
} = require('./simulators/zigbee-device.simulator')
const {
  ModbusDeviceSimulator,
} = require('./simulators/modbus-device.simulator')

const PORT = Number(process.env.DEVICE_LAB_PORT || 4100)
const MQTT_HOST =
  process.env.HOME_MQTT_HOST ||
  process.env.MQTT_HOST ||
  '127.0.0.1'
const MQTT_PORT =
  process.env.HOME_MQTT_PORT ||
  process.env.MQTT_PORT ||
  '1883'
const TENANT_ID = process.env.PORTAL_TENANT_ID || 'tenant-demo'
const SITE_ID =
  process.env.PORTAL_SITE_ID ||
  process.env.HOME_SITE_ID ||
  'site-home'
const PREFIX =
  process.env.HOME_MQTT_TOPIC_PREFIX ||
  `energrid/${TENANT_ID}/${SITE_ID}`

const SITE_NAME =
  process.env.PORTAL_SITE_NAME ||
  process.env.HOME_SITE_NAME ||
  'Device Lab'

const GATEWAY_ID =
  process.env.DEVICE_LAB_GATEWAY_ID ||
  process.env.HOME_GATEWAY_ID ||
  'device-lab-gateway'

const REGISTRATION_MODE =
  process.env.DEVICE_LAB_REGISTRATION_MODE ||
  'discovery'

const PUBLIC_BASE_URL =
  process.env.DEVICE_LAB_PUBLIC_BASE_URL ||
  `http://127.0.0.1:${PORT}`

const publicDir = join(__dirname, 'public')

const devices = new Map(
  configuredDevices.map((config) => {
    const device = createRuntimeDevice(config)
    return [device.id, device]
  }),
)

const activityEvents = []
let activitySequence = 0

const brokerRuntime = {
  status: 'unknown',
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  lastDurationMs: null,
}

function recordActivity(input) {
  const event = {
    id: `lab-event-${Date.now()}-${++activitySequence}`,
    observedAt: new Date().toISOString(),
    level: input.level || 'info',
    kind: input.kind || 'activity',
    stage: input.stage || null,
    deviceId: input.deviceId || null,
    topic: input.topic || null,
    message: input.message || '',
    payload: input.payload ?? null,
    details: input.details || {},
  }

  activityEvents.unshift(event)

  const maxEvents = Number(process.env.DEVICE_LAB_MAX_EVENTS || 300)
  if (activityEvents.length > maxEvents) {
    activityEvents.splice(maxEvents)
  }

  return event
}

const mqttPublisher = new MqttPublisher({
  host: MQTT_HOST,
  port: MQTT_PORT,
})

const registryAnnouncer = new DeviceLabRegistryAnnouncer({
  publisher: mqttPublisher,
  devices,
  prefix: PREFIX,
  tenantId: TENANT_ID,
  siteId: SITE_ID,
  siteName: SITE_NAME,
  gatewayId: GATEWAY_ID,
  registrationMode: REGISTRATION_MODE,
  publicBaseUrl: PUBLIC_BASE_URL,
  recordActivity,
})

const simulatorRegistry = new SimulatorRegistry([
  new MqttDeviceSimulator({
    publisher: mqttPublisher,
    prefix: PREFIX,
  }),
  new HttpDeviceSimulator(),
  new ZigbeeDeviceSimulator({
    publisher: mqttPublisher,
  }),
  new ModbusDeviceSimulator({
    publisher: mqttPublisher,
    prefix: PREFIX,
  }),
])

const deviceLab = new DeviceLabService({
  devices,
  simulatorRegistry,
  broker: {
    host: MQTT_HOST,
    port: String(MQTT_PORT),
    prefix: PREFIX,
  },
  recordActivity,
})

const mqttCommandSubscriber = new MqttCommandSubscriber({
  host: MQTT_HOST,
  port: MQTT_PORT,
  prefix: PREFIX,
  devices,
  deviceLab,
  recordActivity,
})

const server = http.createServer(async (request, response) => {
  try {
    setCors(response)

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url, `http://${request.headers.host}`)

    if (url.pathname === '/api/devices' && request.method === 'GET') {
      return json(response, 200, {
        ...deviceLab.snapshot(),
        registration: registryAnnouncer.snapshot(),
        commandTransport: mqttCommandSubscriber.snapshot(),
        activity: [...activityEvents],
      })
    }

    if (
      url.pathname === '/api/registry/announce' &&
      request.method === 'POST'
    ) {
      const result = await registryAnnouncer.announce(
        'manual Device Lab UI/API request',
      )

      return json(response, result.announced ? 200 : 409, result)
    }

    const behaviorId = routeDeviceId(url.pathname, '/behavior')
    if (behaviorId && request.method === 'PATCH') {
      const body = await readJson(request)
      return json(
        response,
        200,
        deviceLab.updateBehavior(behaviorId, body),
      )
    }

    const telemetryId = routeDeviceId(url.pathname, '/telemetry')
    if (telemetryId && request.method === 'PATCH') {
      const body = await readJson(request)

      return json(
        response,
        200,
        deviceLab.updateTelemetry(telemetryId, body),
      )
    }

    const restartId = routeDeviceId(url.pathname, '/restart')
    if (restartId && request.method === 'POST') {
      return json(
        response,
        200,
        deviceLab.restartTelemetry(restartId),
      )
    }

    const emitId = routeDeviceId(url.pathname, '/emit')
    if (emitId && request.method === 'POST') {
      const observation = await deviceLab.emitNow(
        emitId,
        'manual emit-now request',
      )

      return json(response, 200, observation)
    }

    const onlineId = routeDeviceId(url.pathname, '/online')
    if (onlineId && request.method === 'POST') {
      const body = await readJson(request)
      const device = await deviceLab.setOnline(
        onlineId,
        Boolean(body.online),
      )
      return json(response, 200, device)
    }

    const commandId = routeDeviceId(url.pathname, '/command')
    if (commandId && request.method === 'POST') {
      const body = await readJson(request)
      const result = await deviceLab.executeCommand(commandId, body)

      return json(
        response,
        result.accepted ? 202 : 409,
        result,
      )
    }

    const observeId = routeDeviceId(url.pathname, '/observe')
    if (observeId && request.method === 'POST') {
      const body = await readJson(request)
      const device = await deviceLab.observe(observeId, body)
      return json(response, 200, device)
    }

    const stateId = routePublicDeviceId(url.pathname, '/state')
    if (stateId && request.method === 'GET') {
      return json(response, 200, deviceLab.getHttpState(stateId))
    }

    const relayId = routePublicDeviceId(url.pathname, '/relay')
    if (relayId && request.method === 'POST') {
      const body = await readJson(request)
      const result = await deviceLab.executeCommand(relayId, {
        on: Boolean(body.on),
      })

      return json(
        response,
        result.accepted ? 202 : 409,
        result,
      )
    }

    return serveStatic(url.pathname, response)
  } catch (error) {
    const status = error.statusCode || 500

    return json(response, status, {
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

function routeDeviceId(pathname, suffix) {
  return routeId(pathname, '/api/devices/', suffix)
}

function routePublicDeviceId(pathname, suffix) {
  return routeId(pathname, '/devices/', suffix)
}

function routeId(pathname, prefix, suffix) {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return null
  }

  const encoded = pathname.slice(
    prefix.length,
    pathname.length - suffix.length,
  )

  return encoded ? decodeURIComponent(encoded) : null
}

async function readJson(request) {
  let body = ''

  for await (const chunk of request) {
    body += chunk

    if (body.length > 1_000_000) {
      const error = new Error('Request payload is too large')
      error.statusCode = 413
      throw error
    }
  }

  if (!body.trim()) return {}

  try {
    return JSON.parse(body)
  } catch {
    const error = new Error('Invalid JSON body')
    error.statusCode = 400
    throw error
  }
}

async function serveStatic(pathname, response) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname
  const safePath = normalize(requestedPath).replace(
    /^(\.\.(\/|\\|$))+/,
    '',
  )
  const filePath = join(publicDir, safePath)

  try {
    const content = await readFile(filePath)

    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-store',
    })

    response.end(content)
  } catch {
    json(response, 404, {
      message: 'Not found',
    })
  }
}

function contentType(filePath) {
  const extension = extname(filePath)

  if (extension === '.html') return 'text/html; charset=utf-8'
  if (extension === '.css') return 'text/css; charset=utf-8'
  if (extension === '.js') return 'text/javascript; charset=utf-8'

  return 'application/octet-stream'
}

function setCors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization',
  )
  response.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PATCH, OPTIONS',
  )
}

function json(response, status, body) {
  if (response.headersSent || response.writableEnded) {
    return
  }

  const payload = JSON.stringify(body, null, 2)

  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  })

  response.end(payload)
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[DEVICE LAB] Port ${PORT} is already in use. Stop the existing lab process first.`,
    )
  } else {
    console.error('[DEVICE LAB]', error)
  }

  process.exitCode = 1
})


function shutdown(signal) {
  console.log(`[DEVICE LAB] received ${signal}; stopping simulators`)
  mqttCommandSubscriber.stop()
  deviceLab.stopAll()
  server.close(() => process.exit(0))

  setTimeout(() => process.exit(1), 2000).unref()
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

server.listen(PORT, () => {
  mqttCommandSubscriber.start()
  deviceLab.startAll()

  console.log(`[DEVICE LAB] http://localhost:${PORT}`)
  console.log(`[DEVICE LAB] MQTT ${MQTT_HOST}:${MQTT_PORT}`)
  console.log(`[DEVICE LAB] prefix=${PREFIX}`)
  console.log(
    `[DEVICE LAB] simulators=${simulatorRegistry.describe().join(',')}`,
  )
})
