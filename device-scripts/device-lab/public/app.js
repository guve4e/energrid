const root = document.querySelector('#devices')
const brokerHost = document.querySelector('#brokerHost')
const brokerPrefix = document.querySelector('#brokerPrefix')
const summaryDevices = document.querySelector('#summaryDevices')
const summaryOnline = document.querySelector('#summaryOnline')
const summaryRunning = document.querySelector('#summaryRunning')
const summaryErrors = document.querySelector('#summaryErrors')

let refreshInProgress = false

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  const json = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(json?.message || `Request failed ${response.status}`)
  }

  return json
}

async function refresh() {
  if (refreshInProgress) return
  refreshInProgress = true

  try {
    const snapshot = await api('/api/devices')
    const devices = snapshot.devices || []

    brokerHost.textContent =
      `${snapshot.broker.host}:${snapshot.broker.port}`
    brokerPrefix.textContent = snapshot.broker.prefix

    summaryDevices.textContent = String(devices.length)
    summaryOnline.textContent = String(
      devices.filter((device) => device.online).length,
    )
    summaryRunning.textContent = String(
      devices.filter(
        (device) => device.telemetry?.status === 'running',
      ).length,
    )
    summaryErrors.textContent = String(
      devices.filter((device) => device.telemetry?.lastError).length,
    )

    root.innerHTML = devices.length
      ? devices.map(renderDevice).join('')
      : '<article class="empty-card">No configured devices.</article>'
  } catch (error) {
    root.innerHTML = `
      <article class="empty-card">
        ${escapeHtml(error instanceof Error ? error.message : String(error))}
      </article>
    `
  } finally {
    refreshInProgress = false
  }
}

function renderDevice(device) {
  const telemetry = device.telemetry || {}
  const activity = device.activity || []
  const hasError = Boolean(telemetry.lastError)

  return `
    <article class="device-card ${hasError ? 'error-state' : ''}">
      <header class="card-header">
        <div>
          <span class="protocol-pill">
            ${escapeHtml(protocolLabel(device))}
          </span>
          <h2>${escapeHtml(device.name)}</h2>
          <div class="device-identity">
            ${escapeHtml(device.id)} · ${escapeHtml(device.driver)}
          </div>
        </div>

        <div class="online-status">
          <span class="status-dot ${device.online ? 'online' : ''}"></span>
          ${device.online ? 'Online' : 'Offline'}
        </div>
      </header>

      <div class="telemetry-strip">
        <div class="telemetry-status">
          <span>Autonomous telemetry</span>
          <strong class="${escapeHtml(telemetry.status || 'paused')}">
            ${escapeHtml(telemetry.status || 'unknown')}
          </strong>
        </div>

        <div class="next-emission">
          ${renderNextEmission(telemetry)}
        </div>
      </div>

      <section class="metrics">
        ${renderMetrics(device)}
      </section>

      <section class="card-actions">
        ${renderDeviceActions(device)}

        <button
          type="button"
          onclick="emitNow('${escapeJs(device.id)}')"
        >
          Emit now
        </button>

        <button
          type="button"
          class="${device.online ? 'danger' : ''}"
          onclick="setOnline(
            '${escapeJs(device.id)}',
            ${!device.online}
          )"
        >
          ${device.online ? 'Take offline' : 'Bring online'}
        </button>
      </section>

      <details>
        <summary>⚙ Runtime configuration</summary>

        <div class="settings-panel">
          <section class="settings-section">
            <h3>Telemetry lifecycle</h3>

            <div class="settings-grid">
              <label class="toggle-setting">
                <span>Autonomous emissions</span>
                <input
                  type="checkbox"
                  ${telemetry.enabled ? 'checked' : ''}
                  onchange="updateTelemetry(
                    '${escapeJs(device.id)}',
                    { enabled: this.checked }
                  )"
                />
              </label>

              <label>
                Interval, milliseconds
                <input
                  type="number"
                  min="250"
                  step="250"
                  value="${Number(telemetry.intervalMs || 5000)}"
                  onchange="updateTelemetry(
                    '${escapeJs(device.id)}',
                    { intervalMs: Number(this.value) }
                  )"
                />
              </label>

              ${renderVariationSettings(device)}
            </div>

            <div class="settings-actions">
              <button
                type="button"
                onclick="startTelemetry('${escapeJs(device.id)}')"
              >
                Start
              </button>

              <button
                type="button"
                onclick="pauseTelemetry('${escapeJs(device.id)}')"
              >
                Pause
              </button>

              <button
                type="button"
                onclick="restartTelemetry('${escapeJs(device.id)}')"
              >
                Restart runtime
              </button>
            </div>
          </section>

          <section class="settings-section">
            <h3>Failure simulation</h3>

            <div class="settings-grid">
              ${numberSetting(
                device,
                'delayMs',
                'Command delay',
                device.behavior?.delayMs,
              )}
              ${numberSetting(
                device,
                'unstableForMs',
                'Unstable period',
                device.behavior?.unstableForMs,
              )}
              ${numberSetting(
                device,
                'driftAfterMs',
                'Drift after',
                device.behavior?.driftAfterMs,
              )}
              ${booleanSetting(
                device,
                'dropAcknowledgement',
                'Drop acknowledgement',
                device.behavior?.dropAcknowledgement,
              )}
              ${booleanSetting(
                device,
                'rejectCommand',
                'Reject command',
                device.behavior?.rejectCommand,
              )}
              ${booleanSetting(
                device,
                'reportOppositeState',
                'Report opposite state',
                device.behavior?.reportOppositeState,
              )}
              ${booleanSetting(
                device,
                'staleTelemetry',
                'Publish stale telemetry',
                device.behavior?.staleTelemetry,
              )}
            </div>
          </section>
        </div>
      </details>

      <details ${activity.length ? 'open' : ''}>
        <summary>
          Device activity · ${activity.length} retained event(s)
        </summary>

        <div class="activity-list">
          ${activity.length
            ? activity.map(renderActivity).join('')
            : '<div class="empty-card">No activity yet.</div>'}
        </div>
      </details>
    </article>
  `
}

function protocolLabel(device) {
  if (
    device.protocol !== device.transport &&
    device.transport
  ) {
    return `${device.protocol} via ${device.transport}`
  }

  return device.protocol
}

function renderNextEmission(telemetry) {
  if (telemetry.lastError) {
    return `<strong>${escapeHtml(telemetry.lastError)}</strong>`
  }

  if (telemetry.status !== 'running') {
    return 'No emission scheduled'
  }

  if (!telemetry.nextEmissionAt) {
    return 'Scheduling…'
  }

  const remaining = Date.parse(telemetry.nextEmissionAt) - Date.now()

  return remaining <= 0
    ? 'Emission due'
    : `Next in ${Math.max(1, Math.ceil(remaining / 1000))}s`
}

function renderMetrics(device) {
  const values = device.values || {}
  const units = capabilityUnits(device)
  const entries = Object.entries(values).filter(([, value]) =>
    ['string', 'number', 'boolean'].includes(typeof value),
  )

  if (!entries.length) {
    return `
      <div class="metric">
        <span>State</span>
        <strong>No reading</strong>
      </div>
    `
  }

  return entries
    .map(
      ([key, value]) => `
        <div class="metric">
          <span>${escapeHtml(metricLabel(key))}</span>
          <strong>
            ${escapeHtml(formatMetricValue(value))}
            ${escapeHtml(units[key] || '')}
          </strong>
        </div>
      `,
    )
    .join('')
}

function renderDeviceActions(device) {
  const actions = supportedActions(device)
  const buttons = []

  if (actions.has('turn_on')) {
    buttons.push(actionButton(device, 'turn_on', 'Turn on', true))
  }

  if (actions.has('turn_off')) {
    buttons.push(actionButton(device, 'turn_off', 'Turn off'))
  }

  if (actions.has('open')) {
    buttons.push(actionButton(device, 'open', 'Open', true))
  }

  if (actions.has('close')) {
    buttons.push(actionButton(device, 'close', 'Close'))
  }

  if (actions.has('set_level')) {
    buttons.push(`
      <button
        type="button"
        onclick="setDeviceLevel('${escapeJs(device.id)}')"
      >
        Set level
      </button>
    `)
  }

  return buttons.join('')
}

function actionButton(device, action, label, primary = false) {
  return `
    <button
      type="button"
      class="${primary ? 'primary' : ''}"
      onclick="commandDevice(
        '${escapeJs(device.id)}',
        '${escapeJs(action)}'
      )"
    >
      ${escapeHtml(label)}
    </button>
  `
}

function renderVariationSettings(device) {
  const variation = device.telemetry?.variation || {}

  return Object.entries(variation)
    .map(
      ([key, value]) => `
        <label>
          ${escapeHtml(metricLabel(key))} random variation
          <input
            type="number"
            min="0"
            step="0.01"
            value="${Number(value)}"
            onchange="updateTelemetry(
              '${escapeJs(device.id)}',
              {
                variation: {
                  '${escapeJs(key)}': Number(this.value)
                }
              }
            )"
          />
        </label>
      `,
    )
    .join('')
}

function renderActivity(event) {
  const payload = event.payload
  const payloadText =
    payload === null || payload === undefined
      ? ''
      : JSON.stringify(payload, null, 2)

  return `
    <article class="activity-entry ${escapeHtml(event.level || 'info')}">
      <time>${escapeHtml(formatTime(event.observedAt))}</time>

      <div>
        <strong>
          ${escapeHtml(event.kind || 'activity')}
          ${event.stage ? ` · ${escapeHtml(event.stage)}` : ''}
        </strong>

        <p>${escapeHtml(event.message || '')}</p>

        ${event.topic
          ? `<code>${escapeHtml(event.topic)}</code>`
          : ''}

        ${payloadText
          ? `<code>${escapeHtml(payloadText)}</code>`
          : ''}
      </div>
    </article>
  `
}

function numberSetting(device, key, label, value) {
  return `
    <label>
      ${escapeHtml(label)}, milliseconds
      <input
        type="number"
        min="0"
        value="${Number(value || 0)}"
        onchange="updateBehavior(
          '${escapeJs(device.id)}',
          '${escapeJs(key)}',
          Number(this.value)
        )"
      />
    </label>
  `
}

function booleanSetting(device, key, label, value) {
  return `
    <label class="toggle-setting">
      <span>${escapeHtml(label)}</span>
      <input
        type="checkbox"
        ${value ? 'checked' : ''}
        onchange="updateBehavior(
          '${escapeJs(device.id)}',
          '${escapeJs(key)}',
          this.checked
        )"
      />
    </label>
  `
}

function supportedActions(device) {
  return new Set(
    (device.capabilities || []).flatMap(
      (capability) => capability.actions || [],
    ),
  )
}

function capabilityUnits(device) {
  const units = {}

  for (const capability of device.capabilities || []) {
    if (capability.unit) {
      units[capability.kind] = capability.unit
    }
  }

  return units
}

function metricLabel(key) {
  return String(key)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatMetricValue(value) {
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF'

  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? String(value)
      : value.toFixed(2)
  }

  return String(value)
}

function formatTime(value) {
  const date = new Date(value)

  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleTimeString()
}

async function commandDevice(id, action, extra = {}) {
  await api(`/api/devices/${encodeURIComponent(id)}/command`, {
    method: 'POST',
    body: JSON.stringify({
      action,
      ...extra,
    }),
  })

  await refresh()
}

async function setDeviceLevel(id) {
  const raw = window.prompt('Level from 0 to 100', '50')
  if (raw === null) return

  const level = Number(raw)
  if (!Number.isFinite(level)) return

  await commandDevice(id, 'set_level', { level })
}

async function emitNow(id) {
  await api(`/api/devices/${encodeURIComponent(id)}/emit`, {
    method: 'POST',
    body: '{}',
  })

  await refresh()
}

async function startTelemetry(id) {
  await updateTelemetry(id, { enabled: true })
}

async function pauseTelemetry(id) {
  await updateTelemetry(id, { enabled: false })
}

async function restartTelemetry(id) {
  await api(`/api/devices/${encodeURIComponent(id)}/restart`, {
    method: 'POST',
    body: '{}',
  })

  await refresh()
}

async function updateTelemetry(id, patch) {
  await api(`/api/devices/${encodeURIComponent(id)}/telemetry`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

  await refresh()
}

async function setOnline(id, online) {
  await api(`/api/devices/${encodeURIComponent(id)}/online`, {
    method: 'POST',
    body: JSON.stringify({ online }),
  })

  await refresh()
}

async function updateBehavior(id, key, value) {
  await api(`/api/devices/${encodeURIComponent(id)}/behavior`, {
    method: 'PATCH',
    body: JSON.stringify({ [key]: value }),
  })

  await refresh()
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function escapeJs(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
}

root.innerHTML = document.querySelector('#loadingTemplate').innerHTML

refresh()
setInterval(refresh, 1000)
