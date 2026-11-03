import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue';
import type { PortalState, PortalDevice } from '../../portal-state';
import type { LifecycleDeviceRecord } from '../../components/discovery/network-endpoint-lifecycle';
import { applyEnrollmentPhysicalAssignment, filterInventoryDevices, formatDeviceObservationTime,
  groupInventoryDevices, inventoryConnectionStatus, needsControlSetup } from '../../components/devices/device-inventory';

/** Feature-owned inventory projections, filters and selected-device presentation. */
export function useDeviceInventory(options: {
  state: Ref<PortalState | null>;
  enrolledDeviceKeys: Ref<Set<string>>;
  enrollmentStatuses: Ref<Map<string, 'enrolled' | 'suspended' | 'retired'>>;
  lifecycleEnrollmentRecords: Ref<LifecycleDeviceRecord[]>;
  enrollmentError: Ref<string>;
  deviceStateClock: Ref<number>;
  selectedExecutionTraceId: Ref<string | null>;
  canUseDeviceControl: (device: PortalDevice) => boolean;
  confirmDiscardInstallationChanges: () => boolean;
  onRefresh: () => Promise<void>;
}) {
  const { state, enrolledDeviceKeys, enrollmentStatuses, lifecycleEnrollmentRecords,
    enrollmentError, deviceStateClock, selectedExecutionTraceId,
    canUseDeviceControl, confirmDiscardInstallationChanges, onRefresh } = options;
  const selectedDeviceId = ref<string | null>(null);
  const observationBindingMetrics = ref<Record<string, string[]>>({});
  const measurementApprovalRevision = ref(0);
  const deviceSheet = ref<HTMLElement | null>(null);
  const deviceTableWrap = ref<HTMLElement | null>(null);
  const deviceApprovalFilter = ref<'approved' | 'discovered'>('approved');
  const deviceSourceFilter = ref('site');
  const deviceSearch = ref('');
  const deviceCapabilityFilter = ref('all');
  const deviceZoneFilter = ref('all');
  const deviceStatusFilter = ref('all');

  const deviceCards = computed(() => state.value?.devices || []);

  function deviceEnrollmentStatus(device: PortalDevice): 'enrolled' | 'suspended' | 'retired' | 'not_enrolled' | 'unknown' {
    if (enrollmentError.value) return 'unknown';
    return enrollmentStatuses.value.get(JSON.stringify([device.tenantId, device.siteId, device.id])) || 'not_enrolled';
  }

  const enrolledInventoryDevices = computed(() => deviceCards.value
    .filter(device =>
      device.trustStatus === 'approved' &&
      enrolledDeviceKeys.value.has(
        JSON.stringify([device.tenantId, device.siteId, device.id]),
      ),
    )
    .map(device => {
      const enrollment = lifecycleEnrollmentRecords.value.find(record =>
        record.id === device.id && record.tenantId === device.tenantId && record.siteId === device.siteId,
      );
      return enrollment
        ? applyEnrollmentPhysicalAssignment(device, enrollment.physicalAssignments || [])
        : device;
    }));

  const retiredInventoryDevices = computed(() =>
    deviceCards.value.filter(device =>
      device.trustStatus === 'approved' &&
      enrollmentStatuses.value.get(JSON.stringify([device.tenantId, device.siteId, device.id])) === 'retired',
    ),
  );

  const inventoryDeviceSummary = computed(() => {
    const devices = enrolledInventoryDevices.value;
    const ids = new Set(devices.map(device => device.id));
    const physicalUnits = groupInventoryDevices(devices).length;

    return {
      physicalUnits,
      components: devices.length,
      controllable: devices.filter(canUseDeviceControl).length,
      sensors: devices.filter(device =>
        device.capabilities.some(capability =>
          capability.actions.includes('read'),
        ),
      ).length,
      systems: (state.value?.systems || []).filter(system =>
        system.deviceIds.some(id => ids.has(id)),
      ).length,
      learningEnabled: devices.filter(device =>
        device.responseProfile?.learningEnabled === true,
      ).length,
    };
  });
  const approvedDevices = computed(() =>
    deviceCards.value.filter((device) => device.trustStatus === 'approved'),
  );
  const deviceCapabilityOptions = computed(() => {
    const capabilities = new Set<string>();
    for (const device of enrolledInventoryDevices.value) {
      for (const capability of device.capabilities)
        capabilities.add(capability.kind);
    }
    return [...capabilities].sort((left, right) => left.localeCompare(right));
  });
  const deviceZoneOptions = computed(() => {
    const zones = new Map<string, string>();
    for (const device of enrolledInventoryDevices.value)
      zones.set(device.zoneId, device.zoneName);
    return [...zones.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  });
  const filteredInventoryDevices = computed(() => filterInventoryDevices(enrolledInventoryDevices.value, {
    approval: 'approved',
    source: deviceSourceFilter.value,
    search: deviceSearch.value,
    capability: deviceCapabilityFilter.value,
    zone: deviceZoneFilter.value,
    status: deviceStatusFilter.value,
  }, canUseDeviceControl));
  const filteredPhysicalInventoryGroups = computed(() => groupInventoryDevices(filteredInventoryDevices.value));
  const hasInventoryFilters = computed(() => !!deviceSearch.value || deviceSourceFilter.value !== 'site' || deviceCapabilityFilter.value !== 'all' || deviceZoneFilter.value !== 'all' || deviceStatusFilter.value !== 'all');

  watch([deviceSearch, deviceSourceFilter, deviceCapabilityFilter, deviceZoneFilter, deviceStatusFilter, deviceApprovalFilter], () => {
    if (deviceTableWrap.value) {
      deviceTableWrap.value.scrollTop = 0;
      deviceTableWrap.value.scrollLeft = 0;
    }
  }, { flush: 'post' });

  function clearInventoryFilters() {
    deviceSearch.value = '';
    deviceSourceFilter.value = 'site';
    deviceCapabilityFilter.value = 'all';
    deviceZoneFilter.value = 'all';
    deviceStatusFilter.value = 'all';
  }
  const discoveredDevices = computed(() =>
    deviceCards.value.filter((device) => device.trustStatus === 'discovered'),
  );

  const deviceDiagnostics = computed(() => state.value?.deviceDiagnostics || []);

  const diagnosticSummary = computed(() => ({
    total: deviceDiagnostics.value.length,
    errors: deviceDiagnostics.value.filter((item) => item.severity === 'error')
      .length,
    warnings: deviceDiagnostics.value.filter(
      (item) => item.severity === 'warning',
    ).length,
  }));
  const deviceSourceStats = computed(() => {
    const busBacked = deviceCards.value.filter((device) =>
      ['mqtt', 'zigbee', 'matter', 'modbus'].includes(
        device.adapter.transport || device.adapter.protocol,
      ),
    ).length;
    const needsSetup = deviceCards.value.filter(device => needsControlSetup(device, canUseDeviceControl)).length;
    return [
      {
        label: 'Received',
        value: `${deviceCards.value.length}`,
        detail: 'from portal state',
      },
      {
        label: 'Bus-backed',
        value: `${busBacked}`,
        detail: 'MQTT or bridge adapters',
      },
      {
        label: 'Pending',
        value: `${discoveredDevices.value.length}`,
        detail: 'needs approval',
      },
      {
        label: 'Control setup',
        value: `${needsSetup}`,
        detail: 'approved switches without control',
      },
    ];
  });
  const selectedDevice = computed(() =>
    selectedDeviceId.value
      ? deviceCards.value.find(
          (device) => device.id === selectedDeviceId.value,
        ) || null
      : null,
  );
  const selectedVerifiedSupport = computed(() => {
    if (!selectedDevice.value) return [];
    const listed = selectedDevice.value.supportedCapabilities ?? selectedDevice.value.capabilities;
    return [...new Set([
      ...listed.map((capability) => capability.kind),
      ...(observationBindingMetrics.value[selectedDevice.value.id] || []),
    ])];
  });
  const selectedDeviceTraces = computed(
    () =>
      state.value?.executionTraces
        ?.filter((trace) => trace.deviceId === selectedDeviceId.value)
        .slice(0, 5) || [],
  );
  const siteSystems = computed(() => state.value?.systems || []);
  const deviceSummary = computed(() => {
    if (state.value?.deviceSummary) return state.value.deviceSummary;

    const devices = deviceCards.value;
    const systems = siteSystems.value;

    return {
      total: devices.length,
      approved: approvedDevices.value.length,
      discovered: discoveredDevices.value.length,
      controllable: devices.filter((device) =>
        device.capabilities.some((capability) =>
          capability.actions.some((action) => action !== 'read'),
        ),
      ).length,
      sensors: devices.filter((device) =>
        device.capabilities.some((capability) =>
          capability.actions.includes('read'),
        ),
      ).length,
      systems: systems.length,
      learningEnabled: systems.filter((system) => system.learning.enabled).length,
    };
  });
  function adapterLabel(device: PortalDevice) {
    const protocol = device.adapter.protocol;
    const transport = device.adapter.transport;
    const route =
      transport && transport !== protocol
        ? `${protocol} via ${transport}`
        : protocol;
    return `${route} · ${device.adapter.driver}`;
  }

  function capabilityLabel(device: PortalDevice) {
    return (
      device.capabilities.map((capability) => capability.kind).join(', ') ||
      'unknown'
    );
  }

  function deviceCommandLabel(device: PortalDevice) {
    const actions = device.capabilities
      .flatMap((capability) => capability.actions)
      .filter((action) => action !== 'read');
    if (actions.length === 0) return 'read only';
    return [...new Set(actions)].join(', ');
  }

  function deviceStatusClass(device: PortalDevice) {
    void deviceStateClock.value;
    if (device.trustStatus !== 'approved') return 'amber';
    if (inventoryConnectionStatus(device, deviceStateClock.value) === 'online') return 'green';
    if (['offline', 'stale'].includes(inventoryConnectionStatus(device, deviceStateClock.value))) return 'amber';
    return device.adapter.configured ? 'blue' : 'amber';
  }
  function selectDevice(device: PortalDevice) {
    if (!confirmDiscardInstallationChanges()) return;
    selectedDeviceId.value = device.id;
    void nextTick(() => { deviceSheet.value?.scrollTo?.({ top: 0 }); });
  }

  function closeDeviceSheet() {
    if (!confirmDiscardInstallationChanges()) return;
    selectedDeviceId.value = null;
    selectedExecutionTraceId.value = null;
  }

  function selectMemberDevice(id: string) {
    const member = deviceCards.value.find(device => device.id === id);
    if (member) selectDevice(member);
  }
  function deviceValuePreview(device: PortalDevice) {
    if (device.trustStatus !== 'approved') return 'Awaiting approval';
    const command = device.state.command;
    if (command?.status === 'pending') {
      return `Pending ${expectedOnLabel(command.expectedValues)}`;
    }
    if (command?.status === 'no_ack') {
      return `No ack · expected ${expectedOnLabel(command.expectedValues)}`;
    }
    if (command?.status === 'failed') return 'Command failed';

    const values = device.state.values;
    const parts: string[] = [];

    if (typeof values.temperature === 'number')
      parts.push(`${formatNumber(values.temperature)} C`);
    if (typeof values.humidity === 'number')
      parts.push(`${formatNumber(values.humidity)}%`);
    if (typeof values.power === 'number')
      parts.push(`${formatNumber(values.power)} W`);
    if (typeof values.current === 'number')
      parts.push(`${formatNumber(values.current)} A`);
    if (typeof values.energy === 'number')
      parts.push(`${formatNumber(values.energy)} kWh`);
    if (typeof values.on === 'boolean') parts.unshift(values.on ? 'On' : 'Off');
    if (typeof values.output === 'boolean')
      parts.unshift(values.output ? 'On' : 'Off');

    if (parts.length > 0) return [...new Set(parts)].join(' · ');
    if (Object.keys(values).length > 0) return JSON.stringify(values);
    if (device.memberDeviceIds?.length)
      return `${device.memberDeviceIds.length} members`;
    return device.state.observedAt === null ? 'No readings yet' : device.state.status;
  }

  function deviceStateDetail(device: PortalDevice) {
    void deviceStateClock.value;
    const freshness = inventoryConnectionStatus(device, deviceStateClock.value);
    if (freshness === 'stale') return `Stale · Last observed ${formatDeviceObservationTime(device.state.observedAt)} · current reachability unknown`;
    if (freshness === 'unknown' && device.state.observedAt)
      return 'Current reachability unknown';
    const command = device.state.command;
    if (command?.status === 'pending') return 'waiting for device ack';
    if (command?.status === 'acked') return 'confirmed by telemetry';
    if (command?.status === 'no_ack') return 'published, no telemetry ack';
    if (command?.status === 'failed') return 'publish failed';
    if (Object.keys(device.state.values).length > 0)
      return freshness === 'online'
        ? 'Recent observation · current connectivity not confirmed'
        : 'Latest state received';
    if (device.state.observedAt !== null) return device.state.status;
    return device.adapter.configured ? 'configured · no state yet' : 'not configured';
  }

  function deviceObservedStatus(device: PortalDevice): string {
    void deviceStateClock.value;
    const freshness = inventoryConnectionStatus(device, deviceStateClock.value);
    if (freshness === 'stale') return 'Stale · current reachability unknown';
    if (freshness === 'unknown') return 'Unknown · no recent reachability evidence';
    if (freshness === 'offline') return 'Last reported offline';
    return 'Recent observation · current connectivity not confirmed';
  }

  function expectedOnLabel(
    values: Record<string, number | boolean | string | null>,
  ) {
    const on = values.on ?? values.output ?? values.switch ?? values.powered;
    if (typeof on === 'boolean') return on ? 'On' : 'Off';
    return 'state';
  }

  function formatNumber(value: number) {
    return Number.isInteger(value) ? `${value}` : value.toFixed(1);
  }
  let approvalRefreshTimer: number | undefined;
  function handleObservationAuthorityApproved() {
    if (approvalRefreshTimer !== undefined) window.clearTimeout(approvalRefreshTimer);
    const scope = state.value ? `${state.value.tenant.id}:${state.value.site.id}` : null;
    approvalRefreshTimer = window.setTimeout(() => {
      approvalRefreshTimer = undefined;
      if (!scope || !state.value || `${state.value.tenant.id}:${state.value.site.id}` !== scope) return;
      measurementApprovalRevision.value += 1;
      void onRefresh();
    }, 6000);
  }
  onScopeDispose(() => {
    if (approvalRefreshTimer !== undefined) window.clearTimeout(approvalRefreshTimer);
  });
  function handleDeviceObservationBindings(result: { deviceId: string; metrics: string[] }) {
    observationBindingMetrics.value = {
      ...observationBindingMetrics.value,
      [result.deviceId]: result.metrics,
    };
  }
  return {
    deviceCards, selectedDeviceId, selectedDevice, selectedDeviceTraces, selectedVerifiedSupport,
    observationBindingMetrics, measurementApprovalRevision,
    enrollmentError, deviceSheet, deviceTableWrap, deviceApprovalFilter, deviceSourceFilter, deviceSearch,
    deviceCapabilityFilter, deviceZoneFilter, deviceStatusFilter,
    enrolledInventoryDevices, retiredInventoryDevices, inventoryDeviceSummary, approvedDevices,
    deviceCapabilityOptions, deviceZoneOptions, filteredInventoryDevices, filteredPhysicalInventoryGroups,
    hasInventoryFilters, clearInventoryFilters, discoveredDevices,
    deviceDiagnostics, diagnosticSummary, deviceSourceStats, deviceSummary, siteSystems,
    selectDevice, closeDeviceSheet, selectMemberDevice, deviceEnrollmentStatus,
    adapterLabel, capabilityLabel, deviceCommandLabel, deviceStatusClass,
    deviceValuePreview, deviceStateDetail, deviceObservedStatus,
    handleObservationAuthorityApproved, handleDeviceObservationBindings,
  };
}
export type DeviceInventoryModel = ReturnType<typeof useDeviceInventory>;
