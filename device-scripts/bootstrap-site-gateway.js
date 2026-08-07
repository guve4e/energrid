#!/usr/bin/env node

const { mkdirSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const args = parseArgs(process.argv.slice(2))

const tenantId = required(args.tenant, '--tenant')
const siteId = required(args.site, '--site')
const siteName = args.name || titleFromId(siteId)
const gatewayId = args.gateway || `${siteId}-gateway`
const brokerHost = args.broker || '127.0.0.1'
const mqttPort = args.port || '1883'
const outputDir = resolve(
  args.out || `deploy/site-gateway/generated/${safeFileName(tenantId)}-${safeFileName(siteId)}`,
)
const topicPrefix = `energrid/${safeTopicPart(tenantId)}/${safeTopicPart(siteId)}`
const mqttUsername = args.username || `eg_${safeTopicPart(siteId)}`

mkdirSync(outputDir, { recursive: true })

writeFileSync(
  resolve(outputDir, '.env.site-gateway'),
  [
    `PORTAL_TENANT_ID=${tenantId}`,
    `PORTAL_TENANT_NAME=${args.tenantName || tenantId}`,
    `PORTAL_SITE_ID=${siteId}`,
    `PORTAL_SITE_NAME=${siteName}`,
    `HOME_SITE_ID=${siteId}`,
    `HOME_SITE_NAME=${siteName}`,
    `HOME_GATEWAY_ID=${gatewayId}`,
    `HOME_MQTT_HOST=${brokerHost}`,
    `HOME_MQTT_PORT=${mqttPort}`,
    `HOME_MQTT_USERNAME=${mqttUsername}`,
    'HOME_MQTT_PASSWORD=change-me-on-device',
    `HOME_MQTT_TOPIC_PREFIX=${topicPrefix}`,
    'VOICE_STT_PROVIDER=openai',
    'HOME_APPROVED_DEVICES_JSON={"devices":[]}',
    'HOME_DISCOVERED_DEVICES_JSON=[]',
    '',
  ].join('\n'),
)

writeFileSync(
  resolve(outputDir, 'mosquitto-energrid.conf'),
  [
    'listener 1883 0.0.0.0',
    'allow_anonymous false',
    'password_file /etc/mosquitto/passwd',
    'acl_file /etc/mosquitto/acl.d/energrid.acl',
    'persistence true',
    'persistence_location /var/lib/mosquitto/',
    '',
  ].join('\n'),
)

writeFileSync(
  resolve(outputDir, 'energrid.acl'),
  [
    `user ${mqttUsername}`,
    `topic readwrite ${topicPrefix}/#`,
    '',
    '# Devices can be narrowed later to per-device users:',
    `# user device-temp-kitchen`,
    `# topic write ${topicPrefix}/devices/temp-kitchen/telemetry`,
    `# topic write ${topicPrefix}/devices/temp-kitchen/status`,
    '',
  ].join('\n'),
)

writeFileSync(
  resolve(outputDir, 'README.md'),
  [
    `# Energrid Site Gateway: ${siteName}`,
    '',
    `Tenant: \`${tenantId}\``,
    `Site: \`${siteId}\``,
    `Gateway: \`${gatewayId}\``,
    `MQTT prefix: \`${topicPrefix}\``,
    '',
    '## Install Mosquitto on the site gateway',
    '',
    '```sh',
    'sudo apt update',
    'sudo apt install -y mosquitto mosquitto-clients',
    'sudo install -m 0644 mosquitto-energrid.conf /etc/mosquitto/conf.d/energrid.conf',
    'sudo mkdir -p /etc/mosquitto/acl.d',
    'sudo install -m 0640 energrid.acl /etc/mosquitto/acl.d/energrid.acl',
    `sudo mosquitto_passwd -c /etc/mosquitto/passwd ${mqttUsername}`,
    'sudo systemctl enable mosquitto',
    'sudo systemctl restart mosquitto',
    'sudo systemctl status mosquitto --no-pager',
    '```',
    '',
    '## Attach this site to the Energrid API',
    '',
    'Copy `.env.site-gateway` values into the site API environment file.',
    'Then restart the Energrid API service.',
    '',
    'Expected device topics:',
    '',
    '```txt',
    `${topicPrefix}/devices/{deviceId}/state`,
    `${topicPrefix}/devices/{deviceId}/telemetry`,
    `${topicPrefix}/devices/{deviceId}/status`,
    `${topicPrefix}/devices/{deviceId}/command`,
    `${topicPrefix}/discovery/{source}/{deviceId}`,
    '```',
    '',
    'Discovery is not authority. Approved registry entries are authority.',
    '',
  ].join('\n'),
)

console.log(`Generated site gateway bootstrap in ${outputDir}`)
console.log(`Topic prefix: ${topicPrefix}`)
console.log(`MQTT user: ${mqttUsername}`)

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      result[key] = 'true'
      continue
    }
    result[key] = next
    index += 1
  }
  return result
}

function required(value, name) {
  if (!value) {
    console.error(`Missing ${name}`)
    console.error('Example: pnpm site:gateway:init --tenant valentin --site boyana-home --name "Boyana Home"')
    process.exit(1)
  }
  return value
}

function safeTopicPart(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function safeFileName(value) {
  return safeTopicPart(value) || 'site'
}

function titleFromId(value) {
  return String(value)
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}
