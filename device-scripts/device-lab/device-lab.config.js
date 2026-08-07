const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const devicesPath =
  process.env.DEVICE_LAB_DEVICES_CONFIG ||
  join(__dirname, 'config', 'devices.json')

function loadDevices() {
  const raw = readFileSync(devicesPath, 'utf8')
  const parsed = JSON.parse(raw)

  if (!Array.isArray(parsed)) {
    throw new Error(`Device Lab config must contain an array: ${devicesPath}`)
  }

  const ids = new Set()

  return parsed.map((device, index) => {
    if (!device || typeof device !== 'object') {
      throw new Error(`Device config at index ${index} must be an object`)
    }

    if (!device.id || typeof device.id !== 'string') {
      throw new Error(`Device config at index ${index} is missing id`)
    }

    if (ids.has(device.id)) {
      throw new Error(`Duplicate Device Lab device id: ${device.id}`)
    }

    ids.add(device.id)

    return device
  })
}

module.exports = {
  devices: loadDevices(),
  devicesPath,
  loadDevices,
}
