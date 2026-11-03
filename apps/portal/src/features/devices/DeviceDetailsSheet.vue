<script setup lang="ts">
import type { PortalDevice } from '../../portal-state';
import type { NetworkDevice } from '../discovery/discovery-contracts';
import { inventoryComponentDisplayName } from '../../components/devices/device-inventory';
import { matchNetworkDevice } from '../../components/devices/device-network';
import DeviceCapabilityDetails from '../../components/devices/DeviceCapabilityDetails.vue';
import DeviceControlSetup from '../../components/devices/DeviceControlSetup.vue';
import DeviceConnectionDiagnostics from '../../components/devices/DeviceConnectionDiagnostics.vue';
import DeviceNetworkIdentityPanel from '../../components/devices/DeviceNetworkIdentityPanel.vue';
import DeviceFirmwareDiagnostics from '../../components/devices/DeviceFirmwareDiagnostics.vue';
import DeviceCommissioning from '../../components/devices/DeviceCommissioning.vue';
import type { DeviceInventoryModel } from './useDeviceInventory';
import type { DeviceActionsModel } from './useDeviceActions';

const props = defineProps<{
  inventory: DeviceInventoryModel;
  actions: DeviceActionsModel;
  apiBase: string;
  accessToken: string;
  networkDevices: NetworkDevice[];
  deviceStateClock: number;
  stateError: string;
  discoveryDecisionBusy: Record<string, boolean>;
  discoveryDecisionError: string;
}>();
const emit = defineEmits<{
  refresh: [];
  approve: [device: PortalDevice];
  retired: [];
  reenrolled: [];
  trace: [id: string];
  installationDirty: [dirty: boolean];
}>();
const { selectedDevice, deviceSheet, closeDeviceSheet, selectedVerifiedSupport, selectedDeviceTraces,
  deviceCards, selectMemberDevice, deviceEnrollmentStatus, adapterLabel, deviceObservedStatus,
  measurementApprovalRevision, handleObservationAuthorityApproved, handleDeviceObservationBindings } = props.inventory;
const { canUseDeviceControl, routeIdentityVerified, canToggleDevice, updateHttpIdentityVerification,
  deviceActionBusy, deviceActionError, sendDeviceAction } = props.actions;
</script>
<template>
          <div
            v-if="selectedDevice"
            class="device-sheet-backdrop"
            @click="closeDeviceSheet"
          ></div>
          <aside
            v-if="selectedDevice"
            ref="deviceSheet"
            class="device-sheet"
            aria-label="Device details"
            @keydown.esc="closeDeviceSheet"
          >
            <div class="device-sheet-handle"></div>
            <div class="device-sheet-head">
              <div>
                <span class="eyebrow"
                  >{{ selectedDevice.zoneName }} ·
                  {{ selectedDevice.kind }}</span
                >
                <h3>{{ inventoryComponentDisplayName(selectedDevice) }}</h3>
              </div>
              <button
                class="icon-button"
                type="button"
                aria-label="Close device details"
                @click="closeDeviceSheet"
              >
                ×
              </button>
            </div>


            <DeviceCapabilityDetails
              :device="selectedDevice"
              :api-base="apiBase"
              :access-token="accessToken"
              :now="deviceStateClock"
              :approval-revision="measurementApprovalRevision"
              :control-ready="canUseDeviceControl(selectedDevice)"
              :control-identity-verified="routeIdentityVerified(selectedDevice)"
              :busy="deviceActionBusy[selectedDevice.id]"
              :error="deviceActionError[selectedDevice.id]"
              @action="sendDeviceAction(selectedDevice, $event)"
              @approved="handleObservationAuthorityApproved"
              @bindings="handleDeviceObservationBindings"
            />

            <div class="device-setup-actions">
              <div v-if="selectedDevice.trustStatus !== 'approved'" class="device-approval-actions">
                <strong>Approval required</strong>
                <p v-if="selectedDevice.metadata?.requiresProfileReconciliation === true" role="alert">
                  Historical component conflict: {{ selectedDevice.metadata?.historicalComponentConflicts }}. Fresh RPC confirms {{ selectedDevice.metadata?.component }}. Earlier evidence is preserved; review it before enrollment.
                </p>
                <button type="button" class="primary" :disabled="!!discoveryDecisionBusy[selectedDevice.id]" @click="emit('approve', selectedDevice)">{{ discoveryDecisionBusy[selectedDevice.id] ? 'Approving...' : 'Approve device' }}</button>
                <p v-if="stateError || discoveryDecisionError" role="alert">{{ discoveryDecisionError || stateError }}</p>
              </div>
              <div v-if="selectedDevice.memberDeviceIds?.length" class="device-member-links">
                <h4>Member devices</h4>
                <button v-for="id in selectedDevice.memberDeviceIds" :key="id" type="button" class="ghost" :disabled="!deviceCards.some(device => device.id === id)" @click="selectMemberDevice(id)">{{ deviceCards.find(device => device.id === id)?.displayName || id }}</button>
              </div>
              <details class="device-detail-disclosure">
                <summary>Connection & diagnostics</summary>
                <div class="device-detail-disclosure-content">
                  <DeviceNetworkIdentityPanel
                    :key="selectedDevice.id"
                    :device-id="selectedDevice.id"
                    :device-name="selectedDevice.displayName"
                    :enrollment-status="deviceEnrollmentStatus(selectedDevice)"
                    :protocol="selectedDevice.adapter.protocol"
                    :protocol-endpoint="selectedDevice.adapter.target || selectedDevice.adapter.telemetryTopic || selectedDevice.adapter.eventTopicPrefix"
                    :api-base="apiBase"
                    :access-token="accessToken"
                    @retired="emit('retired')"
                    @reenrolled="emit('reenrolled')"
                    @recovered="emit('reenrolled')"
                  />
                  <DeviceFirmwareDiagnostics
                    v-if="selectedDevice.adapter.driver === 'energrid-esp8266' && selectedDevice.trustStatus === 'approved'"
                    :key="selectedDevice.id"
                    :device-id="selectedDevice.id"
                    :api-base="apiBase"
                    :access-token="accessToken"
                  />
                  <DeviceConnectionDiagnostics v-if="canToggleDevice(selectedDevice) || (selectedDevice.trustStatus === 'approved' && ['shelly-lan', 'shelly-discovered'].includes(selectedDevice.adapter.driver) && /^switch:\d+$/.test(String(selectedDevice.metadata?.component || '')) )" :key="selectedDevice.id" :device="selectedDevice" :api-base="apiBase" :access-token="accessToken" @identity-verification="updateHttpIdentityVerification" @status-observed="emit('refresh')" />
                </div>
              </details>

              <DeviceControlSetup
                v-if="canToggleDevice(selectedDevice)"
                :device="selectedDevice"
                :api-base="apiBase"
                :access-token="accessToken"
                :network-devices="networkDevices"
                @saved="emit('refresh')"
              />

              <details class="device-detail-disclosure">
                <summary>Installation, settings & history</summary>
                <div class="device-detail-disclosure-content">
                  <DeviceCommissioning
                v-if="selectedDevice.trustStatus === 'approved'"
                :device="selectedDevice"
                :api-base="apiBase"
                :access-token="accessToken"
                @dirty-change="emit('installationDirty', $event)"
                :settings-url-suggestion="matchNetworkDevice(selectedDevice, networkDevices)?.settingsUrl"
                @saved="emit('refresh')"
              />
                </div>
              </details>

            </div>

            <dl class="device-facts detail-facts">
              <div>
                <dt>Status</dt>
                <dd>
                  {{ selectedDevice.trustStatus === 'approved' ? (selectedDevice.state.observedAt === null ? 'no state received yet' : deviceObservedStatus(selectedDevice)) : 'awaiting approval' }}
                </dd>
              </div>
              <div>
                <dt>Readings adapter</dt>
                <dd>{{ adapterLabel(selectedDevice) }}</dd>
              </div>
              <div>
                <dt>Readings source</dt>
                <dd>
                  {{
                    selectedDevice.adapter.target ||
                    selectedDevice.adapter.eventTopicPrefix ||
                    'local registry'
                  }}
                </dd>
              </div>
              <div v-if="selectedDevice.adapter.bridge">
                <dt>Bridge</dt>
                <dd>{{ selectedDevice.adapter.bridge }}</dd>
              </div>
              <div>
                <dt>Verified support</dt>
                <dd>
                  {{
                    selectedVerifiedSupport.length
                      ? selectedVerifiedSupport.join(', ')
                      : 'Unknown — no verified capability evidence'
                  }}
                </dd>
              </div>
              <div>
                <dt>Authorized actions</dt>
                <dd>{{ selectedDevice.capabilities.map((capability) => `${capability.kind}:${capability.actions.join('/')}`).join(', ') || 'No authorized observation or command actions' }}</dd>
              </div>
              <div v-if="selectedDevice.discovery || selectedDevice.metadata?.discoverySource">
                <dt>Discovery evidence</dt>
                <dd>{{ selectedDevice.discovery?.reason || `${selectedDevice.metadata?.discoverySource || 'Recorded discovery'} · confidence ${selectedDevice.discovery?.confidence ?? selectedDevice.metadata?.discoveryConfidence ?? 'unknown'}` }}</dd>
              </div>
              <div v-if="selectedDevice.memberDeviceIds?.length">
                <dt>Members</dt>
                <dd>{{ selectedDevice.memberDeviceIds.join(', ') }}</dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>
                  {{
                    Object.keys(selectedDevice.state.values).length
                      ? JSON.stringify(selectedDevice.state.values)
                      : (selectedDevice.state.observedAt === null ? 'unknown - no readings yet' : deviceObservedStatus(selectedDevice))
                  }}
                </dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{{ selectedDevice.state.observedAt || 'unknown' }}</dd>
              </div>

              <div v-if="selectedDeviceTraces.length">
                <dt>Execution history</dt>
                <dd>
                  <div
                    v-for="trace in selectedDeviceTraces"
                    :key="trace.id"
                    class="execution-trace clickable"
                    @click.stop="emit('trace', trace.id)"
                  >
                    <strong>
                      {{ trace.action }}
                      ·
                      {{ trace.outcome }}
                      <span v-if="trace.durationMs">
                        ({{ trace.durationMs }}ms)
                      </span>
                    </strong>

                    <ol>
                      <li
                        v-for="stage in trace.stages"
                        :key="`${trace.id}-${stage.stage}`"
                      >
                        <b>{{ stage.stage }}</b>
                        —
                        {{ stage.message }}
                      </li>
                    </ol>
                  </div>
                </dd>
              </div>

              <div v-if="selectedDevice.adapter.commandTopic">
                <dt>Site-bus command topic</dt>
                <dd>{{ selectedDevice.adapter.commandTopic }}</dd>
              </div>
              <div v-if="selectedDevice.adapter.telemetryTopic">
                <dt>Site-bus telemetry topic</dt>
                <dd>{{ selectedDevice.adapter.telemetryTopic }}</dd>
              </div>
            </dl>
          </aside>

</template>
