<script setup lang="ts">
import { computed } from 'vue';
import NetworkDiscoveryCard from '../../components/discovery/NetworkDiscoveryCard.vue';
import { hasVerifiedEnrolledNetworkIdentity } from '../../components/devices/device-network';
import type { ControlSetupDevice } from '../../components/devices/device-control';
import type { NetworkDevice, DiscoveryNetworkZone, DiscoveryMemoryResponse, SnapshotMarker } from './discovery-contracts';
import { filterNetworkDevices, isEnergridCapableNetworkDevice, networkInventoryStats } from './discovery-network';
import { useDiscoveryNetworkModel, useDiscoveryInventoryUiState, type DiscoveryInventoryUiState } from './useDiscoveryNetworkModel';

const props = defineProps<{
  liveNetworkDevices: NetworkDevice[];
  memory: DiscoveryMemoryResponse | null;
  memoryLoading: boolean;
  memoryError: string;
  networkZones: DiscoveryNetworkZone[];
  networkSnapshots: SnapshotMarker[];
  serverLabel: string;
  enrolledDevices: ControlSetupDevice[];
  channelPhysicalIds: string[];
  aiInvestigating: Record<string, boolean>;
  uiState?: DiscoveryInventoryUiState;
}>();
const emit = defineEmits<{
  refreshMemory: [];
  review: [id: string];
  investigate: [device: NetworkDevice];
  channels: [device: NetworkDevice];
  copySsh: [line: string];
}>();
const ui = props.uiState ?? useDiscoveryInventoryUiState();
const search = computed({ get: () => ui.search.value, set: value => { ui.search.value = value; } });
const view = computed({ get: () => ui.view.value, set: value => { ui.view.value = value; } });
const memoryExpanded = computed({ get: () => ui.memoryExpanded.value, set: value => { ui.memoryExpanded.value = value; } });
const { networkDevices, historicalNetworkDevices, latestMemoryMarkerVerification } = useDiscoveryNetworkModel(
  () => props.liveNetworkDevices, () => props.memory, () => props.networkSnapshots,
);
const visibleNetworkDevices = computed(() => filterNetworkDevices(networkDevices.value, view.value, search.value));
const networkStats = computed(() => networkInventoryStats(networkDevices.value, props.liveNetworkDevices, props.memory, props.networkZones));
function hasChannels(device: NetworkDevice) {
  return !!device.components?.length || props.channelPhysicalIds.includes(device.id);
}
function deviceHasSsh(device: NetworkDevice): boolean {
  return device.observations?.some(observation => observation.source === 'tcp' &&
    observation.attribute === 'port.22.open' && observation.value === true) === true;
}
function networkDeviceClass(device: NetworkDevice): string {
  if (device.status === 'online' && device.protocol === 'http') return 'discovered';
  return isEnergridCapableNetworkDevice(device) ? 'discovered' : 'unknown';
}
function networkDeviceBadge(device: NetworkDevice): string {
  const integration = device.status === 'online' && device.protocol === 'http' ? 'HTTP observed'
    : isEnergridCapableNetworkDevice(device) ? 'capable' : 'network only';
  return hasVerifiedEnrolledNetworkIdentity(device, props.enrolledDevices) ? `enrolled · ${integration}` : integration;
}
function memoryDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
async function copySshCommand(device: NetworkDevice): Promise<void> {
  const command = `ssh ${device.ipAddress}`;
  try { await navigator.clipboard.writeText(command); emit('copySsh', `[discovery] copied SSH command for ${device.id}`); }
  catch { window.prompt('Copy SSH command:', command); }
}
</script>
<template>
  <div class="network-scan">
    <div class="scan-origin">
      <div>
        <span>Scan origin</span>
        <strong>{{ serverLabel || 'same-origin API' }}</strong>
      </div>
      <div>
        <span>Source of truth</span>
        <strong>site brain network view</strong>
      </div>
    </div>
    <div class="section-row">
      <div>
        <h3>Visible from the local brain</h3>
        <span class="section-help"
          >The browser is not scanning. The API/site brain scans the
          networks it can reach.</span
        >
      </div>
      <div class="discovery-toolbar">
        <input
          v-model="search"
          type="search"
          aria-label="Search network devices"
          placeholder="Search IP, hostname, MAC, vendor..."
        />
        <button
          v-if="search"
          type="button"
          class="secondary"
          @click="search = ''"
        >
          Clear
        </button>

        <span
          >{{ visibleNetworkDevices.length }} shown ·
          {{ networkDevices.length }} found</span
        >
        <div class="segmented compact">
          <button
            type="button"
            :class="{ active: view === 'all' }"
            :aria-pressed="view === 'all'"
            @click="view = 'all'"
          >
            All devices
          </button>
          <button
            type="button"
            :class="{ active: view === 'capable' }"
            :aria-pressed="view === 'capable'"
            @click="view = 'capable'"
          >
            Shelly devices
          </button>
        </div>
      </div>
    </div>
    <div class="network-stat-grid">
      <div v-for="item in networkStats" :key="item.label">
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
        <small>{{ item.detail }}</small>
      </div>
    </div>
    <div class="zone-strip" v-if="networkZones.length > 0">
      <span v-for="zone in networkZones" :key="zone.id">
        <strong>{{ zone.name }}</strong>
        {{
          zone.cidr ||
          zone.interfaceName ||
          `${zone.seedIps.length} seeds`
        }}
      </span>
    </div>
    <div
      class="discovery-empty compact"
      v-if="networkDevices.length === 0"
    >
      <strong>No current or remembered endpoints</strong>
      <span
        >Run a scan to list devices visible from the local brain,
        including Shelly settings pages when they respond.</span
      >
    </div>
    <div
      class="discovery-empty compact"
      v-else-if="visibleNetworkDevices.length === 0"
    >
      <strong>
        {{ search
          ? 'No devices match your search'
          : 'No Energrid-capable devices in this view' }}
      </strong>
      <span
        >Switch to all devices to see every host the site brain found on
        the configured networks.</span
      >
    </div>
    <div v-else class="discovery-zone-groups">
      <details
        v-for="zone in networkZones.filter(z => visibleNetworkDevices.some(d => d.networkZoneId === z.id))"
        :key="zone.id"
        class="discovery-accordion"
        open
      >
        <summary>
          <strong>{{ zone.name }}</strong>
          <span>{{ visibleNetworkDevices.filter(d => d.networkZoneId === zone.id).length }} devices · {{ zone.cidr }}</span>
        </summary>
        <div class="network-device-list">
          <NetworkDiscoveryCard
            v-for="device in visibleNetworkDevices.filter(d => d.networkZoneId === zone.id)"
            :key="device.networkZoneId + ':' + device.ipAddress"
            :device="device"
            :badge="networkDeviceBadge(device)"
            :badge-class="networkDeviceClass(device)"
            :investigating="aiInvestigating[device.id]"
            :has-ssh="deviceHasSsh(device)"
            :has-channels="hasChannels(device)"
            :identity-conflict="device.identityConflict"
            @review="emit('review', device.id)"
            @investigate="emit('investigate', device)"
            @channels="emit('channels', device)"
            @copy-ssh="copySshCommand(device)"
          />
        </div>
      </details>
    </div>

    <section id="discovery-memory" class="discovery-memory-section">
      <div class="section-row">
        <div>
          <h3>Discovery Memory</h3>
          <span class="section-help">
            Persistent network history. Not observed does not mean offline.
          </span>
        </div>
        <button
          type="button"
          class="secondary"
          :disabled="memoryLoading"
          @click="emit('refreshMemory')"
        >
          {{ memoryLoading ? 'Loading...' : 'Refresh memory' }}
        </button>
      </div>

      <p v-if="memoryError" role="alert">
        {{ memoryError }}
      </p>

      <div v-if="memory" class="network-stat-grid">
        <div>
          <span>Known</span>
          <strong>{{ memory.summary.known }}</strong>
          <small>Remembered across scans</small>
        </div>
        <div>
          <span>{{ latestMemoryMarkerVerification ? 'Updated in latest selected-device check' : 'Observed in latest scan' }}</span>
          <strong>{{ memory.summary.observedInLatestScan }}</strong>
          <small v-if="latestMemoryMarkerVerification">One endpoint was checked; no subnet scan was run.</small>
          <small v-else>Latest completed scan</small>
        </div>
        <div>
          <span>{{ latestMemoryMarkerVerification ? 'Other remembered endpoints' : 'Not observed' }}</span>
          <strong>{{ memory.summary.notObservedInLatestScan }}</strong>
          <small>Not necessarily offline</small>
        </div>
      </div>

      <div v-if="memory" class="section-row">
        <span class="section-help">
          {{ historicalNetworkDevices.length }} historical records
        </span>
        <button
          type="button"
          class="secondary"
          :aria-expanded="memoryExpanded"
          @click="memoryExpanded = !memoryExpanded"
        >
          {{ memoryExpanded ? 'Hide history' : 'Show history' }}
        </button>
      </div>

      <div
        v-if="memory && memoryExpanded"
        class="network-table-wrap"
      >
        <table class="network-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Last known address</th>
              <th>Model</th>
              <th>First seen</th>
              <th>Last seen</th>
              <th>Observation</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="record in historicalNetworkDevices"
              :key="record.identity"
            >
              <td data-label="Device">
                <strong>
                  {{ record.device.vendor || record.device.hostname || 'Network device' }}
                </strong>
                <span>{{ record.device.id }}</span>
              </td>
              <td data-label="Last known address">
                <strong>{{ record.device.ipAddress }}</strong>
                <span>{{ record.device.macAddress || 'MAC unknown' }}</span>
                <span v-if="record.device.identityConflict" role="status">
                  Conflicting MAC evidence: {{ record.device.identityConflict.macAddresses.join(', ') }}
                </span>
              </td>
              <td data-label="Model">
                {{ record.device.model || record.device.protocol || 'Unknown' }}
              </td>
              <td data-label="First seen">
                {{ memoryDate(record.firstSeenAt) }}
              </td>
              <td data-label="Last seen">
                {{ memoryDate(record.lastSeenAt) }}
              </td>
              <td data-label="Observation">
                <span>
                  {{
                    latestMemoryMarkerVerification
                      ? record.observedInLatestScan ? 'Updated in latest selected-device check' : 'Not touched by latest selected-device check'
                      : record.observedInLatestScan ? 'Observed in latest scan' : 'Not observed in latest scan'
                  }}
                </span>
              </td>
            </tr>
            <tr v-if="historicalNetworkDevices.length === 0">
              <td colspan="6">
                No devices remembered yet. Run a network scan.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>

</template>
