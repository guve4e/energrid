const { spawn } = require('node:child_process')

class MqttCommandSubscriber {
  constructor({
    host,
    port,
    prefix,
    devices,
    deviceLab,
    recordActivity = () => {},
    command,
  }) {
    this.host = host
    this.port = String(port)
    this.prefix = String(prefix).replace(/\/+$/, '')
    this.devices = devices
    this.deviceLab = deviceLab
    this.recordActivity = recordActivity

    this.command =
      command ||
      process.env.HOME_MQTT_SUB_COMMAND ||
      'mosquitto_sub'

    this.process = null
    this.buffer = ''
    this.status = 'stopped'
    this.lastError = null
    this.lastReceivedAt = null
    this.receivedCount = 0
  }

  snapshot() {
    return {
      status: this.status,
      topic: `${this.prefix}/devices/+/command`,
      lastError: this.lastError,
      lastReceivedAt: this.lastReceivedAt,
      receivedCount: this.receivedCount,
    }
  }

  start() {
    if (this.process) return

    const topic = `${this.prefix}/devices/+/command`
    const args = [
      '-h',
      this.host,
      '-p',
      this.port,
      '-t',
      topic,
      '-v',
    ]

    if (process.env.HOME_MQTT_USERNAME) {
      args.push('-u', process.env.HOME_MQTT_USERNAME)
    }

    if (process.env.HOME_MQTT_PASSWORD) {
      args.push('-P', process.env.HOME_MQTT_PASSWORD)
    }

    this.process = spawn(this.command, args)
    this.status = 'running'
    this.lastError = null

    this.recordActivity({
      kind: 'command-transport',
      stage: 'subscribed',
      topic,
      message: `Device Lab subscribed for MQTT commands on ${topic}.`,
    })

    this.process.stdout.on('data', (chunk) => {
      this.handleStdout(String(chunk))
    })

    this.process.stderr.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (!message) return

      this.lastError = message

      this.recordActivity({
        level: 'warn',
        kind: 'command-transport',
        stage: 'stderr',
        topic,
        message,
      })
    })

    this.process.on('error', (error) => {
      this.status = 'failed'
      this.lastError = error.message
      this.process = null

      this.recordActivity({
        level: 'error',
        kind: 'command-transport',
        stage: 'failed',
        topic,
        message: error.message,
      })
    })

    this.process.on('exit', (code, signal) => {
      this.status = 'stopped'
      this.process = null

      this.recordActivity({
        level: code === 0 ? 'info' : 'warn',
        kind: 'command-transport',
        stage: 'stopped',
        topic,
        message:
          `MQTT command subscriber stopped ` +
          `code=${code ?? '-'} signal=${signal ?? '-'}.`,
      })
    })
  }

  stop() {
    this.process?.kill()
    this.process = null
    this.status = 'stopped'
    this.buffer = ''
  }

  handleStdout(chunk) {
    this.buffer += chunk

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex < 0) return

      const line = this.buffer.slice(0, newlineIndex).trim()
      this.buffer = this.buffer.slice(newlineIndex + 1)

      if (!line) continue

      Promise.resolve(this.handleLine(line)).catch((error) => {
        this.recordActivity({
          level: 'error',
          kind: 'command-transport',
          stage: 'processing-failed',
          message:
            error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  async handleLine(line) {
    const separator = line.indexOf(' ')
    if (separator < 1) return

    const topic = line.slice(0, separator)
    const payloadText = line.slice(separator + 1).trim()

    const device = this.deviceFromTopic(topic)

    if (!device) {
      this.recordActivity({
        level: 'warn',
        kind: 'command-transport',
        stage: 'unknown-device',
        topic,
        message: 'Command topic did not match a configured Device Lab device.',
        payload: payloadText,
      })

      return
    }

    let payload

    try {
      payload = JSON.parse(payloadText)
    } catch {
      this.recordActivity({
        level: 'warn',
        kind: 'command-transport',
        stage: 'invalid-json',
        deviceId: device.id,
        topic,
        message: 'Device Lab received a non-JSON command.',
        payload: payloadText,
      })

      return
    }

    this.lastReceivedAt = new Date().toISOString()
    this.receivedCount += 1

    this.recordActivity({
      kind: 'command-transport',
      stage: 'device-received',
      deviceId: device.id,
      topic,
      message:
        `${device.name} received ${payload.action || 'unknown'} ` +
        `from the MQTT broker.`,
      payload,
      details: {
        commandId: payload.commandId || null,
      },
    })

    await this.deviceLab.executeCommand(device.id, payload)
  }

  deviceFromTopic(topic) {
    const prefix = `${this.prefix}/devices/`
    const suffix = '/command'

    if (!topic.startsWith(prefix) || !topic.endsWith(suffix)) {
      return null
    }

    const topicDeviceId = topic.slice(
      prefix.length,
      topic.length - suffix.length,
    )

    for (const device of this.devices.values()) {
      if (mqttDeviceKey(device.id) === topicDeviceId) {
        return device
      }
    }

    return null
  }
}

function mqttDeviceKey(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
}

module.exports = {
  MqttCommandSubscriber,
  mqttDeviceKey,
}
