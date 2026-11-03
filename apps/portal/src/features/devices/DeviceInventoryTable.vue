<script setup lang="ts">
import DeviceSwitchControl from '../../components/devices/DeviceSwitchControl.vue';
import { controlRouteLabel } from '../../components/devices/device-control';
import { inventoryComponentDisplayName, isExampleDevice, physicalComponentLabel } from '../../components/devices/device-inventory';
import type { DeviceInventoryModel } from './useDeviceInventory';
import type { DeviceActionsModel } from './useDeviceActions';

const props = defineProps<{ inventory: DeviceInventoryModel; actions: DeviceActionsModel }>();
const { deviceSearch, deviceSourceFilter, deviceCapabilityFilter, deviceZoneFilter, deviceStatusFilter,
  deviceCapabilityOptions, deviceZoneOptions, filteredInventoryDevices, filteredPhysicalInventoryGroups,
  hasInventoryFilters, clearInventoryFilters, retiredInventoryDevices, enrolledInventoryDevices,
  inventoryDeviceSummary, deviceSourceStats, enrollmentError, deviceTableWrap, selectedDeviceId,
  selectDevice, adapterLabel, capabilityLabel, deviceCommandLabel, deviceStatusClass,
  deviceValuePreview, deviceStateDetail } = props.inventory;
const { canUseDeviceControl, routeIdentityVerified, canToggleDevice, deviceActionBusy, deviceActionError, sendDeviceAction } = props.actions;
</script>
<template>
          <div class="device-inventory-content">
          <div class="summary-strip">
            <div>
              <span>Physical devices</span>
              <strong>{{ inventoryDeviceSummary.physicalUnits }}</strong>
            </div>
            <div>
              <span>Components</span>
              <strong>{{ inventoryDeviceSummary.components }}</strong>
            </div>
            <div>
              <span>Controllable</span>
              <strong>{{ inventoryDeviceSummary.controllable }}</strong>
            </div>
            <div>
              <span>Sensors</span>
              <strong>{{ inventoryDeviceSummary.sensors }}</strong>
            </div>
            <div>
              <span>Systems</span>
              <strong>{{ inventoryDeviceSummary.systems }}</strong>
            </div>
            <div>
              <span>Learning</span>
              <strong>{{ inventoryDeviceSummary.learningEnabled }}</strong>
            </div>
          </div>

          <div class="device-source-strip">
            <div v-for="item in deviceSourceStats" :key="item.label">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
              <small>{{ item.detail }}</small>
            </div>
          </div>



          <div class="device-inventory-toolbar">
            <label class="search-field inventory-search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M10.5 17a6.5 6.5 0 1 1 5.1-2.48l3.44 3.44-1.08 1.08-3.44-3.44A6.47 6.47 0 0 1 10.5 17Zm0-1.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"
                />
              </svg>
              <input
                v-model="deviceSearch"
                type="search"
                aria-label="Search devices"
                placeholder="Search devices, topics, zones"
              />
            </label>
            <select v-model="deviceSourceFilter" aria-label="Filter by source">
              <option value="site">Site devices</option>
              <option value="examples">Examples</option>
              <option value="all">All sources</option>
            </select>
            <select
              v-model="deviceCapabilityFilter"
              aria-label="Filter by capability"
            >
              <option value="all">All types</option>
              <option
                v-for="capability in deviceCapabilityOptions"
                :key="capability"
                :value="capability"
              >
                {{ capability }}
              </option>
            </select>
            <select v-model="deviceZoneFilter" aria-label="Filter by zone">
              <option value="all">All zones</option>
              <option
                v-for="zone in deviceZoneOptions"
                :key="zone.id"
                :value="zone.id"
              >
                {{ zone.name }}
              </option>
            </select>
            <select v-model="deviceStatusFilter" aria-label="Filter by status">
              <option value="all">All statuses</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="controllable">Controllable</option>
              <option value="needs_setup">Needs setup</option>
            </select>
            <div class="inventory-filter-summary">
              <span role="status" aria-live="polite" aria-atomic="true">{{ filteredInventoryDevices.length }} {{ filteredInventoryDevices.length === 1 ? 'component' : 'components' }} · {{ filteredPhysicalInventoryGroups.length }} {{ filteredPhysicalInventoryGroups.length === 1 ? 'physical device' : 'physical devices' }}</span>
              <button type="button" class="ghost" :disabled="!hasInventoryFilters" @click="clearInventoryFilters">Clear filters</button>
            </div>
          </div>

          <div v-if="retiredInventoryDevices.length" class="retired-device-list">
            <h4>Retired devices</h4>
            <button v-for="device in retiredInventoryDevices" :key="device.id" type="button" class="ghost" @click="selectDevice(device)">
              {{ device.displayName }} · {{ device.id }}
            </button>
          </div>

          <div
            v-if="enrollmentError"
            class="discovery-empty compact"
            role="alert"
          >
            <strong>Device inventory unavailable</strong>
            <span>{{ enrollmentError }}</span>
          </div>
          <div
            v-else-if="enrolledInventoryDevices.length === 0"
            class="discovery-empty compact"
          >
            <strong>No enrolled devices yet</strong>
            <span
              >Approve devices from Discovery or publish them through the site
              bus.</span
            >
          </div>
          <div
            v-else-if="filteredInventoryDevices.length === 0"
            class="discovery-empty compact"
          >
            <strong>No devices match this filter</strong>
            <span
              >Clear search or loosen the capability, zone, or status
              filters.</span
            >
          </div>
          <div v-else ref="deviceTableWrap" class="network-table-wrap device-table-wrap">
            <table class="network-table device-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Zone</th>
                  <th>Capability</th>
                  <th>Adapter</th>
                  <th>State</th>
                  <th>Control</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="group in filteredPhysicalInventoryGroups" :key="group.key">
                <tr class="physical-device-group-row" :data-physical-inventory-id="group.physicalInventoryId || 'unlinked'">
                  <td colspan="6">
                    <strong>{{ group.label }}</strong>
                    <span>{{ group.components.length }} {{ group.components.length === 1 ? 'component' : 'components' }}</span>
                    <small v-if="group.physicalId">{{ group.physicalId }}</small>
                    <small v-if="group.physicalInventoryId">Physical Inventory {{ group.physicalInventoryId }}</small>
                    <small v-else>Physical Inventory association not recorded; shown separately</small>
                  </td>
                </tr>
                <tr
                  v-for="device in group.components"
                  :key="device.id"
                  :id="`device-record-${encodeURIComponent(device.id)}`"
                  :class="{ selected: selectedDeviceId === device.id, 'physical-device-component-row': true }"
                  :data-component="device.metadata?.component || ''"
                  @click="selectDevice(device)"
                >
                  <td data-label="Device">
                    <button type="button" class="device-name-button" @click.stop="selectDevice(device)">{{ inventoryComponentDisplayName(device) }}</button>
                    <span>{{ physicalComponentLabel(device) }} · {{ device.kind }} · {{ device.id }}</span>
                    <span v-if="isExampleDevice(device)" class="device-example-label">Example / simulation</span>
                    <span v-else-if="device.trustStatus !== 'approved'" class="device-approval-label">Approval required</span>
                  </td>
                  <td data-label="Zone">
                    <strong>{{ device.zoneName }}</strong>
                    <span>{{
                      device.memberDeviceIds?.length
                        ? `${device.memberDeviceIds.length} members`
                        : device.siteName
                    }}</span>
                  </td>
                  <td data-label="Capability">
                    <strong>{{ capabilityLabel(device) }}</strong>
                    <span>{{ deviceCommandLabel(device) }}</span>
                  </td>
                  <td data-label="Adapter">
                    <strong>{{ device.adapter.driver }}</strong>
                    <span>{{ adapterLabel(device) }}</span>
                  </td>
                  <td data-label="State">
                    <span class="inventory-status">
                      <span :class="['dot', deviceStatusClass(device)]"></span>
                      <strong>{{ deviceValuePreview(device) }}</strong>
                    </span>
                    <span>{{ deviceStateDetail(device) }}</span>
                  </td>
                  <td data-label="Control">
                    <DeviceSwitchControl
                      v-if="canUseDeviceControl(device)"
                      :device="device"
                      :identity-verified="routeIdentityVerified(device)"
                      :busy="deviceActionBusy[device.id]"
                      :error="deviceActionError[device.id]"
                      @action="sendDeviceAction(device, $event)"
                    />
                    <button v-else-if="device.trustStatus !== 'approved'" type="button" class="ghost" @click.stop="selectDevice(device)">Review device</button>
                    <button v-else-if="canToggleDevice(device)" type="button" class="secondary" @click.stop="selectDevice(device)">{{ device.memberDeviceIds?.length ? 'Set up members' : device.control?.binding?.kind === 'shelly-http' ? 'Verify route' : 'Configure control' }}</button>
                    <span v-else class="trust-pill approved">Read only</span>
                    <span v-if="canToggleDevice(device)">{{ controlRouteLabel(device) }}</span>
                  </td>
                </tr>
                </template>
              </tbody>
            </table>
          </div>

          </div>
</template>
