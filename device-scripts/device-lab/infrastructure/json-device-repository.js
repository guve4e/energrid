const { readFile, writeFile } = require('node:fs/promises')
const { dirname, resolve } = require('node:path')
const { mkdir } = require('node:fs/promises')
const { SimulatedDevice } = require('../domain/simulated-device')

class JsonDeviceRepository {
  constructor(options = {}) {
    this.definitionsPath = resolve(
      options.definitionsPath ||
        process.env.DEVICE_LAB_DEVICES_FILE ||
        resolve(__dirname, '../config/devices.json'),
    )

    this.runtimeProfilesPath = resolve(
      options.runtimeProfilesPath ||
        process.env.DEVICE_LAB_RUNTIME_FILE ||
        resolve(__dirname, '../config/runtime-profiles.json'),
    )
  }

  async load() {
    const definitionsDocument = await readJsonFile(this.definitionsPath)
    const runtimeDocument = await readJsonFile(
      this.runtimeProfilesPath,
      { version: 1, profiles: {} },
    )

    const definitions = Array.isArray(definitionsDocument.devices)
      ? definitionsDocument.devices
      : []

    const profiles =
      runtimeDocument.profiles &&
      typeof runtimeDocument.profiles === 'object'
        ? runtimeDocument.profiles
        : {}

    const devices = new Map()

    for (const definition of definitions) {
      const device = new SimulatedDevice(
        definition,
        profiles[definition.id] || {},
      )

      if (devices.has(device.id)) {
        throw new Error(`Duplicate Device Lab device id ${device.id}.`)
      }

      devices.set(device.id, device)
    }

    return devices
  }

  async saveRuntimeProfiles(devices) {
    const profiles = {}

    for (const [id, device] of devices.entries()) {
      profiles[id] = device.runtimeProfile()
    }

    const document = {
      version: 1,
      updatedAt: new Date().toISOString(),
      profiles,
    }

    await mkdir(dirname(this.runtimeProfilesPath), {
      recursive: true,
    })

    await writeFile(
      this.runtimeProfilesPath,
      `${JSON.stringify(document, null, 2)}\n`,
      'utf8',
    )
  }
}

async function readJsonFile(path, fallback) {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (fallback !== undefined && error?.code === 'ENOENT') {
      return fallback
    }

    throw new Error(
      `Cannot read Device Lab JSON file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

module.exports = {
  JsonDeviceRepository,
}
