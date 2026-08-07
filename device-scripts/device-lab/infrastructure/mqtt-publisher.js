const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

class MqttPublisher {
  constructor(options = {}) {
    this.host =
      options.host ||
      process.env.HOME_MQTT_HOST ||
      process.env.MQTT_HOST ||
      '127.0.0.1'

    this.port = String(
      options.port ||
        process.env.HOME_MQTT_PORT ||
        process.env.MQTT_PORT ||
        '1883',
    )

    this.command =
      options.command ||
      process.env.HOME_MQTT_PUB_BIN ||
      'mosquitto_pub'

    this.timeoutMs = Number(
      options.timeoutMs ||
        process.env.HOME_DEVICE_WRITE_TIMEOUT_MS ||
        2500,
    )
  }

  async publish(topic, payload, options = {}) {
    if (!topic) throw new Error('MQTT topic is required')

    const payloadText =
      typeof payload === 'string' ? payload : JSON.stringify(payload)

    const args = [
      '-h',
      this.host,
      '-p',
      this.port,
      '-t',
      topic,
      '-m',
      payloadText,
    ]

    if (options.retain === true) {
      args.push('-r')
    }

    if (Number.isInteger(options.qos)) {
      args.push('-q', String(Math.max(0, Math.min(2, options.qos))))
    }

    if (process.env.HOME_MQTT_USERNAME) {
      args.push('-u', process.env.HOME_MQTT_USERNAME)
    }

    if (process.env.HOME_MQTT_PASSWORD) {
      args.push('-P', process.env.HOME_MQTT_PASSWORD)
    }

    await execFileAsync(this.command, args, {
      timeout: this.timeoutMs,
    })

    return {
      topic,
      payloadBytes: Buffer.byteLength(payloadText, 'utf8'),
      retained: options.retain === true,
      qos: Number.isInteger(options.qos) ? options.qos : 0,
    }
  }
}

module.exports = {
  MqttPublisher,
}
