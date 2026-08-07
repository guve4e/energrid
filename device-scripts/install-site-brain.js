#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir, userInfo } = require('node:os')
const { join, resolve } = require('node:path')
const { randomBytes } = require('node:crypto')

const args = parseArgs(process.argv.slice(2))
const apply = args.apply === 'true'
const repoDir = resolve(args.dir || process.cwd())
const tenantId = required(args.tenant, '--tenant')
const siteId = required(args.site, '--site')
const siteName = args.name || titleFromId(siteId)
const tenantName = args.tenantName || tenantId
const domain = args.domain || 'portal.energrid.bg'
const serviceUser = args.user || currentUser()
const envFile = resolve(args.envFile || join(repoDir, '.env'))
const networkCidr = args.network || inferPrimaryNetwork() || '192.168.1.0/24'
const networkName = args.networkName || 'Home LAN'
const gatewayId = args.gateway || `${siteId}-gateway`
const mqttHost = args.mqttHost || '127.0.0.1'
const mqttPort = args.mqttPort || '1883'
const mqttUsername = args.mqttUsername || `eg_${safeTopicPart(siteId)}`
const mqttPassword = args.mqttPassword || randomBytes(18).toString('base64url')
const topicPrefix = args.topicPrefix || `energrid/${safeTopicPart(tenantId)}/${safeTopicPart(siteId)}`
const sttProvider = args.stt || 'openai'
const installPackages = args.packages !== 'false'
const buildApps = args.build !== 'false'
const restartServices = args.restart !== 'false'
const networkZonesJson = JSON.stringify({
  zones: [
    {
      id: safeTopicPart(args.networkId || 'home-lan'),
      name: networkName,
      cidr: networkCidr,
      role: args.networkRole || 'primary',
    },
  ],
})

const envValues = {
  PORT: '3000',
  PORTAL_TENANT_ID: tenantId,
  PORTAL_TENANT_NAME: tenantName,
  PORTAL_SITE_ID: siteId,
  PORTAL_SITE_NAME: siteName,
  PORTAL_SITE_MODE: args.mode || 'home',
  HOME_SITE_ID: siteId,
  HOME_SITE_NAME: siteName,
  HOME_GATEWAY_ID: gatewayId,
  HOME_NETWORK_ZONES_JSON: networkZonesJson,
  HOME_LAN_ACTIVE_SCAN_ENABLED: 'true',
  HOME_LAN_ACTIVE_SCAN_MAX_HOSTS: args.maxHosts || '254',
  HOME_MQTT_INGEST_ENABLED: 'true',
  HOME_MQTT_HOST: mqttHost,
  HOME_MQTT_PORT: mqttPort,
  HOME_MQTT_USERNAME: mqttUsername,
  HOME_MQTT_PASSWORD: mqttPassword,
  HOME_MQTT_TOPIC_PREFIX: topicPrefix,
  HOME_SHELLY_RPC_TOPIC: args.shellyRpcTopic || 'shelly/rpc',
  PORTAL_DEVICE_PROXY_WRITE_ENABLED: args.proxyWrite || 'false',
  VOICE_STT_PROVIDER: sttProvider,
}

if (sttProvider === 'local-whisper') {
  envValues.LOCAL_WHISPER_PYTHON = args.whisperPython || join(repoDir, '.venv/bin/python')
  envValues.LOCAL_WHISPER_MODEL = args.whisperModel || 'tiny'
  envValues.LOCAL_WHISPER_LANGUAGE = args.whisperLanguage || 'bg'
  envValues.LOCAL_WHISPER_WORKER = 'true'
}

if (args.legacyTemperatureTopics) {
  envValues.HOME_MQTT_LEGACY_TEMPERATURE_TOPICS = args.legacyTemperatureTopics
}

if (args.routerClientsFile) {
  envValues.HOME_ROUTER_CLIENTS_FILE = args.routerClientsFile
}

if (args.routerClientsCommand) {
  envValues.HOME_ROUTER_CLIENTS_COMMAND = args.routerClientsCommand
}

if (args.routerClientsCommandArgs) {
  envValues.HOME_ROUTER_CLIENTS_COMMAND_ARGS = args.routerClientsCommandArgs
}

const mosquittoConf = [
  'listener 1883 0.0.0.0',
  'allow_anonymous false',
  'password_file /etc/mosquitto/passwd',
  'acl_file /etc/mosquitto/acl.d/energrid.acl',
  'persistence true',
  'persistence_location /var/lib/mosquitto/',
  '',
].join('\n')

const mosquittoAcl = [
  `user ${mqttUsername}`,
  `topic readwrite ${topicPrefix}/#`,
  'topic readwrite shelly/#',
  '',
  '# Narrow device credentials later. The site brain needs broad installer access first.',
  '',
].join('\n')

const nginxConf = [
  'server {',
  '  listen 80;',
  '  listen [::]:80;',
  `  server_name ${domain};`,
  '',
  `  root ${repoDir}/dist/apps/portal;`,
  '  index index.html;',
  '  client_max_body_size 25m;',
  '',
  '  location /voice {',
  '    proxy_pass http://127.0.0.1:3000;',
  '    proxy_http_version 1.1;',
  '    proxy_set_header Upgrade $http_upgrade;',
  '    proxy_set_header Connection "upgrade";',
  '    proxy_set_header Host $host;',
  '    proxy_set_header X-Real-IP $remote_addr;',
  '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '    proxy_set_header X-Forwarded-Proto $scheme;',
  '    proxy_read_timeout 3600s;',
  '    proxy_send_timeout 3600s;',
  '  }',
  '',
  '  location /auth {',
  '    proxy_pass http://127.0.0.1:3000;',
  '    proxy_set_header Host $host;',
  '    proxy_set_header X-Real-IP $remote_addr;',
  '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '    proxy_set_header X-Forwarded-Proto $scheme;',
  '  }',
  '',
  '  location /portal {',
  '    proxy_pass http://127.0.0.1:3000;',
  '    proxy_set_header Host $host;',
  '    proxy_set_header X-Real-IP $remote_addr;',
  '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '    proxy_set_header X-Forwarded-Proto $scheme;',
  '  }',
  '',
  '  location / {',
  '    try_files $uri $uri/ /index.html;',
  '  }',
  '}',
  '',
].join('\n')

const systemdService = [
  '[Unit]',
  'Description=Energrid API',
  'After=network-online.target mosquitto.service',
  'Wants=network-online.target mosquitto.service',
  '',
  '[Service]',
  'Type=simple',
  `User=${serviceUser}`,
  `WorkingDirectory=${repoDir}`,
  `EnvironmentFile=${envFile}`,
  'Environment=NODE_ENV=production',
  `ExecStart=/usr/bin/node ${repoDir}/dist/api/main.js`,
  'Restart=always',
  'RestartSec=5',
  '',
  '[Install]',
  'WantedBy=multi-user.target',
  '',
].join('\n')

const plan = []
if (installPackages) {
  plan.push(['sudo', 'apt-get', 'update'])
  plan.push(['sudo', 'apt-get', 'install', '-y', 'nginx', 'mosquitto', 'mosquitto-clients', 'ffmpeg'])
}
if (buildApps) {
  plan.push(['pnpm', 'install', '--frozen-lockfile'])
  plan.push(['pnpm', 'nx', 'build', 'api', '--skip-nx-cache'])
  plan.push(['pnpm', 'nx', 'build', 'portal', '--skip-nx-cache'])
}
plan.push(['sudo', 'install', '-m', '0644', '<generated mosquitto conf>', '/etc/mosquitto/conf.d/energrid.conf'])
plan.push(['sudo', 'install', '-m', '0640', '<generated mosquitto acl>', '/etc/mosquitto/acl.d/energrid.acl'])
plan.push(['sudo', 'mosquitto_passwd', '-b', '-c', '/etc/mosquitto/passwd', mqttUsername, '<generated password>'])
plan.push(['sudo', 'install', '-m', '0644', '<generated nginx conf>', `/etc/nginx/sites-available/${domain}`])
plan.push(['sudo', 'ln', '-sf', `/etc/nginx/sites-available/${domain}`, `/etc/nginx/sites-enabled/${domain}`])
plan.push(['sudo', 'rm', '-f', '/etc/nginx/sites-enabled/default'])
plan.push(['sudo', 'install', '-m', '0644', '<generated systemd service>', '/etc/systemd/system/energrid-api.service'])
plan.push(['sudo', 'systemctl', 'daemon-reload'])
plan.push(['sudo', 'systemctl', 'enable', 'mosquitto'])
plan.push(['sudo', 'systemctl', 'enable', 'energrid-api'])
plan.push(['sudo', 'nginx', '-t'])
if (restartServices) {
  plan.push(['sudo', 'systemctl', 'restart', 'mosquitto'])
  plan.push(['sudo', 'systemctl', 'restart', 'energrid-api'])
  plan.push(['sudo', 'systemctl', 'reload', 'nginx'])
}

printSummary()

if (!apply) {
  console.log('\nDry run only. Re-run with --apply on the Pi to install.')
  process.exit(0)
}

if (installPackages) {
  run(['sudo', 'apt-get', 'update'])
  run(['sudo', 'apt-get', 'install', '-y', 'nginx', 'mosquitto', 'mosquitto-clients', 'ffmpeg'])
}

upsertEnvFile(envFile, envValues)

if (buildApps) {
  run(['pnpm', 'install', '--frozen-lockfile'], { cwd: repoDir })
  run(['pnpm', 'nx', 'build', 'api', '--skip-nx-cache'], { cwd: repoDir })
  run(['pnpm', 'nx', 'build', 'portal', '--skip-nx-cache'], {
    cwd: repoDir,
    env: { ...process.env, VITE_BACKEND_LABEL: 'same-origin' },
  })
}

installRootFile(mosquittoConf, '/etc/mosquitto/conf.d/energrid.conf', '0644')
run(['sudo', 'mkdir', '-p', '/etc/mosquitto/acl.d'])
installRootFile(mosquittoAcl, '/etc/mosquitto/acl.d/energrid.acl', '0640')
run(['sudo', 'mosquitto_passwd', '-b', '-c', '/etc/mosquitto/passwd', mqttUsername, mqttPassword])
installRootFile(nginxConf, `/etc/nginx/sites-available/${domain}`, '0644')
run(['sudo', 'ln', '-sf', `/etc/nginx/sites-available/${domain}`, `/etc/nginx/sites-enabled/${domain}`])
run(['sudo', 'rm', '-f', '/etc/nginx/sites-enabled/default'])
installRootFile(systemdService, '/etc/systemd/system/energrid-api.service', '0644')
run(['sudo', 'systemctl', 'daemon-reload'])
run(['sudo', 'systemctl', 'enable', 'mosquitto'])
run(['sudo', 'systemctl', 'enable', 'energrid-api'])
run(['sudo', 'nginx', '-t'])

if (restartServices) {
  run(['sudo', 'systemctl', 'restart', 'mosquitto'])
  run(['sudo', 'systemctl', 'restart', 'energrid-api'])
  run(['sudo', 'systemctl', 'reload', 'nginx'])
}

console.log('\nEnergrid site brain installed.')
console.log(`Portal: http://${domain}`)
console.log('Health checks:')
console.log('  curl http://localhost/voice/config')
console.log('  curl http://localhost/portal/state')

function printSummary() {
  console.log('Energrid site brain bootstrap')
  console.log(`Mode: ${apply ? 'apply' : 'dry-run'}`)
  console.log(`Repo: ${repoDir}`)
  console.log(`Tenant/site: ${tenantId} / ${siteId}`)
  console.log(`Site name: ${siteName}`)
  console.log(`Network zone: ${networkName} ${networkCidr}`)
  console.log(`Domain: ${domain}`)
  console.log(`MQTT: ${mqttHost}:${mqttPort} prefix=${topicPrefix} user=${mqttUsername}`)
  console.log(`System user: ${serviceUser}`)
  console.log(`Env file: ${envFile}`)
  console.log('\nCommands:')
  for (const command of plan) {
    console.log(`  ${command.map(shellQuote).join(' ')}`)
  }
}

function upsertEnvFile(filePath, values) {
  const previous = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  if (previous) {
    const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    writeFileSync(backupPath, previous)
    console.log(`Backed up ${filePath} to ${backupPath}`)
  }

  const lines = previous.split(/\r?\n/)
  const used = new Set()
  const next = lines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const match = line.match(/^([A-Z0-9_]+)=/)
      if (!match || !(match[1] in values)) return line
      used.add(match[1])
      return `${match[1]}=${quoteEnv(values[match[1]])}`
    })

  next.push('', '# Energrid site brain')
  for (const [key, value] of Object.entries(values)) {
    if (!used.has(key)) next.push(`${key}=${quoteEnv(value)}`)
  }
  next.push('')
  writeFileSync(filePath, next.join('\n'))
  console.log(`Wrote ${filePath}`)
}

function installRootFile(content, destination, mode) {
  const tempPath = join(tmpdir(), `energrid-${safeFileName(destination)}-${Date.now()}`)
  writeFileSync(tempPath, content)
  run(['sudo', 'install', '-m', mode, tempPath, destination])
}

function run(command, options = {}) {
  console.log(`\n$ ${command.map(shellQuote).join(' ')}`)
  execFileSync(command[0], command.slice(1), {
    cwd: options.cwd || repoDir,
    env: options.env || process.env,
    stdio: 'inherit',
  })
}

function inferPrimaryNetwork() {
  try {
    const output = execFileSync('ip', ['route'], { encoding: 'utf8' })
    const route = output
      .split(/\r?\n/)
      .find((line) =>
        /^192\.168\.\d+\.0\/24 dev (?!docker|br-|veth)/.test(line) ||
        /^10\.\d+\.\d+\.0\/24 dev (?!docker|br-|veth)/.test(line),
      )
    return route?.match(/^(\S+)/)?.[1] || null
  } catch {
    return null
  }
}

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
  if (value) return value
  console.error(`Missing ${name}`)
  console.error('Example: pnpm site:bootstrap --tenant valentin --site boyana-home --name "Boyana Home" --network 192.168.1.0/24')
  process.exit(1)
}

function currentUser() {
  try {
    return userInfo().username || 'pi'
  } catch {
    return 'pi'
  }
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

function quoteEnv(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text
  return JSON.stringify(text)
}

function shellQuote(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text
  return `'${text.replace(/'/g, "'\\''")}'`
}
