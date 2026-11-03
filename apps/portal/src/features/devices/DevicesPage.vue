<script setup lang="ts">
import type { PortalDevice } from '../../portal-state';
import type { NetworkDevice } from '../discovery/discovery-contracts';
import type { DeviceInventoryModel } from './useDeviceInventory';
import type { DeviceActionsModel } from './useDeviceActions';
import DeviceInventoryTable from './DeviceInventoryTable.vue';
import DeviceDetailsSheet from './DeviceDetailsSheet.vue';

const props = defineProps<{
  inventory: DeviceInventoryModel;
  actions: DeviceActionsModel;
  apiBase: string;
  accessToken: string;
  networkDevices: NetworkDevice[];
  loadingState: boolean;
  streamStatus: 'idle' | 'connecting' | 'syncing' | 'connected' | 'reconnecting';
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
</script>
<template>
<section class="panel workspace-panel devices-workspace">
          <div class="page-heading">
            <p class="eyebrow">Site Inventory</p>
            <h2>Devices</h2>
            <span class="device-state-stream-status" role="status" :data-status="streamStatus">
              Portal event connection: {{ ({ idle: 'not connected', connecting: 'connecting', syncing: 'reconciling latest state', connected: 'connected', reconnecting: 'reconnecting' } as const)[streamStatus] }}
            </span>
            <button type="button" class="ghost" :disabled="loadingState" @click="emit('refresh')">{{ loadingState ? 'Refreshing...' : 'Refresh' }}</button>
          </div>
<DeviceInventoryTable :inventory="inventory" :actions="actions" />
<DeviceDetailsSheet
  :inventory="inventory" :actions="actions" :api-base="apiBase" :access-token="accessToken"
  :network-devices="networkDevices" :device-state-clock="deviceStateClock"
  :state-error="stateError" :discovery-decision-busy="discoveryDecisionBusy"
  :discovery-decision-error="discoveryDecisionError"
  @refresh="emit('refresh')" @approve="emit('approve', $event)"
  @retired="emit('retired')" @reenrolled="emit('reenrolled')"
  @trace="emit('trace', $event)" @installation-dirty="emit('installationDirty', $event)"
/>
</section>
</template>
