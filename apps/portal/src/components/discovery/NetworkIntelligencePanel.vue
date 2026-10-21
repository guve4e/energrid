<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { networkEndpointInvestigationKey, networkEndpointSafeCheckLabels, type NetworkEndpointInvestigationState } from './network-endpoint-investigation';

type Scope = { id: string; name: string; cidr?: string; interfaceName?: string; seedIps?: string[] };
type Observation = { source: string; attribute: string; value: string | number | boolean; observedAt: string; method?: string };
type Endpoint = {
  id: string; ipAddress: string; networkZoneId: string; networkZoneName: string;
  macAddress?: string; deviceReportedMacAddress?: string; hostname?: string; vendor?: string;
  model?: string; app?: string; protocol: string; status: string; discoveredAt: string; reason: string;
  components?: Array<{ component: string; channel: number }>;
  identityConflict?: { reason: string; macAddresses: string[] };
  observations?: Observation[];
};
type ScopeSnapshot = { id: string; name: string; cidr?: string; interfaceName?: string; complete: boolean; gatewayIpsObserved: string[] };
type Snapshot = {
  scanId: string; schemaVersion: number; startedAt: string; completedAt: string;
  collector: { id: string; host: string; interfaces: string[] };
  scopes: ScopeSnapshot[]; methods: string[]; successes: number; failures: string[]; limitations: string[];
  endpoints: Endpoint[];
  topology: { relationships: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }> };
  runtime?: Observer;
};
type Diff = {
  fromScanId: string; toScanId: string; comparableScopes: string[]; incompleteScopes: string[];
  addedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  notDetectedEndpoints: Array<{ scopeId: string; ipAddress: string; macAddress?: string }>;
  verifiedAddressChanges: Array<{ identity: string; from: string; to: string }>;
  ipReuse: Array<{ scopeId: string; ipAddress: string; previousIdentity?: string; currentIdentity?: string }>;
  serviceChanges: Array<{ scopeId: string; ipAddress: string; added: string[]; removed: string[] }>;
  scopeChanges: Array<{ scopeId: string; previousCidr?: string; currentCidr?: string; previousInterface?: string; currentInterface?: string }>;
  macChanges: Array<{ identity: string; previousObservedMac?: string; currentObservedMac?: string; previousDeviceReportedMac?: string; currentDeviceReportedMac?: string }>;
  gatewayChanges: Array<{ scopeId: string; previous: string[]; current: string[] }>;
  identityChanges: Array<{ scopeId: string; ipAddress: string; previous: string; current: string }>;
  topologyChanges: { added: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }>; removed: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }> };
};
type Observer = {
  observedAt: string;
  observer: { id: string; host: string; platform: string };
  interfaces: Array<{ name: string; internal: boolean; macAddress?: string; addresses: Array<{ family: string; address: string; netmask?: string; prefixLength?: number; cidr?: string }> }>;
  routes: Array<{ destination: string; family: string; gateway?: string; interfaceName?: string; sourceAddress?: string; evidence: string }>;
  localScopes: Array<{ cidr: string; interfaceName: string }>;
  configuredScopes: Array<{ id: string; name: string; cidr?: string; interfaceName?: string; reachability: string; boundedScanEligible: boolean; reason: string }>;
  capabilities: Array<{ id: string; available: boolean; detail: string }>;
  limitations: string[];
};
type EndpointLifecycle = {
  endpointKey: string;
  stage: 'observed' | 'identified' | 'pending' | 'approved' | 'enrolled' | 'unknown';
  recordId?: string;
  recordName?: string;
  relatedRecords?: number;
  detail?: string;
};

const props = withDefaults(defineProps<{
  scopes: Scope[]; snapshots: Snapshot[]; latest: Snapshot | null; comparison: Diff | null;
  nmapCapability?: { available: boolean; enabled: boolean; version?: string; reason?: string } | null;
  observer?: Observer | null;
  pendingCount?: number | null;
  enrolledCount?: number | null;
  enrollmentStateAvailable?: boolean;
  endpointLifecycle?: EndpointLifecycle[];
  endpointInvestigations?: Record<string, NetworkEndpointInvestigationState>;
  busy?: boolean; error?: string;
}>(), { enrollmentStateAvailable: true });
const emit = defineEmits<{
  scan: [scopeIds: string[]]; cancel: [];
  openPending: [recordId?: string]; openDevice: [recordId: string];
  investigateEndpoint: [request: { scanId: string; scopeId: string; ipAddress: string; endpointId: string }];
}>();

const selectedScopeId = ref('');
const selectedEndpointKey = ref('');
const search = ref('');
const identityFilter = ref<'all' | 'verified' | 'unidentified'>('all');
const diagnosticsOpen = ref(false);
const mobileViewport = ref(false);
const mobileDetailsOpen = ref(false);
let mobileMediaQuery: MediaQueryList | undefined;

function updateViewport() {
  mobileViewport.value = window.matchMedia?.('(max-width: 640px)').matches ?? window.innerWidth <= 640;
}

onMounted(() => {
  updateViewport();
  mobileMediaQuery = window.matchMedia?.('(max-width: 640px)');
  mobileMediaQuery?.addEventListener?.('change', updateViewport);
  window.addEventListener('resize', updateViewport);
});
onBeforeUnmount(() => {
  mobileMediaQuery?.removeEventListener?.('change', updateViewport);
  window.removeEventListener('resize', updateViewport);
});

const availableScopes = computed<Scope[]>(() => props.scopes.length
  ? props.scopes
  : (props.latest?.scopes || []).map(scope => ({ id: scope.id, name: scope.name, cidr: scope.cidr })));

watch([availableScopes, () => props.latest?.scanId], () => {
  const validIds = new Set(availableScopes.value.map(scope => scope.id));
  if (!validIds.has(selectedScopeId.value)) {
    selectedScopeId.value = props.latest?.scopes[0]?.id || availableScopes.value[0]?.id || '';
  }
}, { immediate: true });

function endpointKey(endpoint: Endpoint): string {
  return `${endpoint.networkZoneId}:${endpoint.ipAddress}:${endpoint.id}`;
}

function verifiedIdentity(endpoint: Endpoint): boolean {
  const shellyIdentity = endpoint.observations?.some(observation =>
    observation.source === 'http_rpc' && observation.attribute === 'shelly.device_id' && observation.value === endpoint.id,
  );
  return shellyIdentity === true || endpoint.observations?.some(observation =>
    observation.attribute === 'identity.verified' && observation.value === true,
  ) === true;
}

function endpointServices(endpoint: Endpoint): string[] {
  return [...new Set((endpoint.observations || []).flatMap(observation => {
    const service = /^port\.(\d+)\.service$/.exec(observation.attribute);
    if (service && observation.source === 'tcp' && typeof observation.value === 'string') return [`${observation.value} · TCP ${service[1]}`];
    const port = /^port\.(\d+)\.open$/.exec(observation.attribute);
    return port && observation.source === 'tcp' && observation.value === true ? [`TCP ${port[1]}`] : [];
  }))];
}

const selectedScope = computed(() => availableScopes.value.find(scope => scope.id === selectedScopeId.value) || null);
const scopeSnapshot = computed(() => props.latest?.scopes.find(scope => scope.id === selectedScopeId.value) || null);
const endpoints = computed(() => (props.latest?.endpoints || []).filter(endpoint => endpoint.networkZoneId === selectedScopeId.value));
const verifiedCount = computed(() => endpoints.value.filter(verifiedIdentity).length);
const unidentifiedCount = computed(() => Math.max(0, endpoints.value.length - verifiedCount.value));
const recentChangeCount = computed(() => {
  const diff = props.comparison;
  if (!diff || !diff.comparableScopes.includes(selectedScopeId.value)) return 0;
  return diff.addedEndpoints.filter(item => item.scopeId === selectedScopeId.value).length
    + diff.verifiedAddressChanges.length
    + diff.ipReuse.filter(item => item.scopeId === selectedScopeId.value).length
    + diff.serviceChanges.filter(item => item.scopeId === selectedScopeId.value).length
    + diff.macChanges.length
    + diff.identityChanges.filter(item => item.scopeId === selectedScopeId.value).length;
});
const selectedEndpoint = computed(() => endpoints.value.find(endpoint => endpointKey(endpoint) === selectedEndpointKey.value) || null);
const selectedInvestigationKey = computed(() => selectedEndpoint.value && props.latest
  ? networkEndpointInvestigationKey(props.latest.scanId, selectedEndpoint.value.networkZoneId, selectedEndpoint.value.ipAddress, selectedEndpoint.value.id)
  : '');
const selectedInvestigation = computed(() => selectedInvestigationKey.value
  ? props.endpointInvestigations?.[selectedInvestigationKey.value] || null
  : null);
const visibleEndpoints = computed(() => {
  const query = search.value.trim().toLowerCase();
  return endpoints.value.filter(endpoint => {
    if (identityFilter.value === 'verified' && !verifiedIdentity(endpoint)) return false;
    if (identityFilter.value === 'unidentified' && verifiedIdentity(endpoint)) return false;
    if (!query) return true;
    return [endpoint.hostname, endpoint.vendor, endpoint.model, endpoint.id, endpoint.ipAddress, endpoint.macAddress]
      .some(value => value?.toLowerCase().includes(query));
  });
});
const coverageLabel = computed(() => {
  if (!props.latest) return 'No scan yet';
  if (!scopeSnapshot.value) return 'No observation for this scope';
  const incomplete = !scopeSnapshot.value.complete
    || props.latest.failures.length > 0
    || props.comparison?.incompleteScopes.includes(selectedScopeId.value);
  return incomplete ? 'Partial coverage' : 'Scan complete';
});
const lastScanLabel = computed(() => props.latest ? new Date(props.latest.completedAt).toLocaleString() : 'Awaiting first scan');
const identityName = (endpoint: Endpoint) => endpoint.hostname || [endpoint.vendor, endpoint.model || endpoint.app].filter(Boolean).join(' ') || 'Unidentified endpoint';

watch(() => props.latest?.scanId, () => {
  if (endpoints.value.length && !endpoints.value.some(endpoint => endpointKey(endpoint) === selectedEndpointKey.value)) {
    selectedEndpointKey.value = endpointKey(endpoints.value.find(verifiedIdentity) || endpoints.value[0]);
  }
}, { immediate: true });

watch(selectedScopeId, () => {
  if (endpoints.value.length) selectedEndpointKey.value = endpointKey(endpoints.value.find(verifiedIdentity) || endpoints.value[0]);
  else selectedEndpointKey.value = '';
});

function selectEndpoint(endpoint: Endpoint) {
  selectedEndpointKey.value = endpointKey(endpoint);
  mobileDetailsOpen.value = mobileViewport.value;
  if (mobileDetailsOpen.value) void nextTick(() => document.querySelector<HTMLElement>('.ni-detail-close')?.focus());
}

function endpointLifecycle(endpoint: Endpoint): EndpointLifecycle['stage'] {
  if (!verifiedIdentity(endpoint)) return 'observed';
  const matched = props.endpointLifecycle?.find(item => item.endpointKey === endpointKey(endpoint));
  if (matched?.stage === 'identified' && props.enrollmentStateAvailable === false) return 'unknown';
  return matched?.stage || (props.enrollmentStateAvailable === false ? 'unknown' : 'identified');
}

function lifecycleLabel(stage: EndpointLifecycle['stage']): string {
  return ({
    observed: 'Observed endpoint',
    identified: 'Identified · not enrolled',
    pending: 'Pending approval',
    approved: 'Approved · enrollment inactive',
    enrolled: 'Approved · enrolled',
    unknown: 'Enrollment state unavailable',
  })[stage];
}

function lifecycleFor(endpoint: Endpoint): EndpointLifecycle | undefined {
  return props.endpointLifecycle?.find(item => item.endpointKey === endpointKey(endpoint));
}

function closeDetails() {
  const key = selectedEndpointKey.value;
  mobileDetailsOpen.value = false;
  selectedEndpointKey.value = '';
  if (mobileViewport.value && key) void nextTick(() => {
    [...document.querySelectorAll<HTMLElement>('.ni-device-row')]
      .find(row => row.dataset.endpointKey === key)?.focus();
  });
}

function runScan() {
  if (selectedScopeId.value) emit('scan', [selectedScopeId.value]);
}

function investigateSelectedEndpoint() {
  if (!selectedEndpoint.value || !props.latest || verifiedIdentity(selectedEndpoint.value) || selectedEndpoint.value.identityConflict) return;
  emit('investigateEndpoint', {
    scanId: props.latest.scanId,
    scopeId: selectedEndpoint.value.networkZoneId,
    ipAddress: selectedEndpoint.value.ipAddress,
    endpointId: selectedEndpoint.value.id,
  });
}

function evidenceLabel(id: string): string {
  const item = selectedInvestigation.value?.result?.evidence.find(evidence => evidence.id === id);
  return item ? `${item.attribute} · ${item.source} · ${date(item.observedAt)}` : 'Snapshot evidence';
}

function safeCheckLabel(action: string): string {
  return action in networkEndpointSafeCheckLabels
    ? networkEndpointSafeCheckLabels[action as keyof typeof networkEndpointSafeCheckLabels]
    : 'Review evidence with an operator';
}

function date(value?: string) {
  if (!value) return 'Time unavailable';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Time unavailable' : parsed.toLocaleString();
}
</script>

<template>
  <main class="network-intelligence-page" aria-labelledby="network-intelligence-title">
    <header class="ni-header">
      <div>
        <p class="ni-eyebrow">Network overview</p>
        <h1 id="network-intelligence-title">Network Intelligence</h1>
        <p class="ni-subtitle">A clear view of observed endpoints and verified device identities.</p>
      </div>
      <div class="ni-header-actions">
        <label class="ni-scope-select">
          <span>Network</span>
          <select v-model="selectedScopeId" aria-label="Select network scope" :disabled="availableScopes.length === 0">
            <option v-for="scope in availableScopes" :key="scope.id" :value="scope.id">{{ scope.name }}{{ scope.cidr ? ` · ${scope.cidr}` : '' }}</option>
            <option v-if="availableScopes.length === 0" value="">No configured scopes</option>
          </select>
        </label>
        <button v-if="busy" type="button" class="ni-button ni-button-secondary" @click="emit('cancel')">Cancel scan</button>
        <button v-else type="button" class="ni-button ni-button-primary" :disabled="!selectedScopeId" @click="runScan">Scan network</button>
      </div>
    </header>

    <div class="ni-status-row" aria-live="polite">
      <span :class="['ni-status-pill', coverageLabel === 'Scan complete' ? 'is-complete' : coverageLabel === 'Partial coverage' ? 'is-partial' : 'is-neutral']">
        <span aria-hidden="true">{{ coverageLabel === 'Scan complete' ? '✓' : coverageLabel === 'Partial coverage' ? '!' : '•' }}</span>{{ busy ? 'Scan in progress' : coverageLabel }}
      </span>
      <span class="ni-last-scan">{{ busy ? 'Collecting bounded network evidence…' : `Last scan · ${lastScanLabel}` }}</span>
      <p v-if="error" class="ni-error" role="alert">{{ error }}</p>
    </div>

    <nav class="ni-lifecycle-links" aria-label="Device lifecycle">
      <button type="button" class="ni-lifecycle-link" @click="emit('openPending')">
        <span>Pending</span><strong>{{ pendingCount ?? '—' }}</strong><span class="ni-lifecycle-destination">Discovery Inbox ›</span>
      </button>
      <button type="button" class="ni-lifecycle-link" @click="emit('openDevice', '')">
        <span>Enrolled</span><strong>{{ enrolledCount ?? '—' }}</strong><span class="ni-lifecycle-destination">Devices ›</span>
      </button>
      <span v-if="enrollmentStateAvailable === false" class="ni-lifecycle-unavailable" role="status">Enrollment data is unavailable; endpoint lifecycle links are limited.</span>
    </nav>

    <section v-if="latest" class="ni-metrics" aria-label="Selected network summary">
      <article><strong>{{ endpoints.length }}</strong><span>Observed endpoints</span></article>
      <article><strong>{{ verifiedCount }}</strong><span>Verified identities</span></article>
      <article><strong>{{ unidentifiedCount }}</strong><span>Unidentified</span></article>
      <article><strong>{{ recentChangeCount }}</strong><span>Recent changes</span></article>
    </section>

    <section v-if="latest" class="ni-overview" aria-labelledby="ni-overview-title">
      <div class="ni-section-heading">
        <div><h2 id="ni-overview-title">{{ selectedScope?.name || 'Network' }} overview</h2><p>{{ selectedScope?.cidr || scopeSnapshot?.cidr || 'Configured scope' }}<template v-if="scopeSnapshot?.interfaceName"> · observed from {{ scopeSnapshot.interfaceName }}</template></p></div>
        <span>{{ endpoints.length }} {{ endpoints.length === 1 ? 'endpoint' : 'endpoints' }}</span>
      </div>
      <div v-if="endpoints.length" class="ni-explorer" role="list" aria-label="Observed endpoints grouped by network">
        <button v-for="endpoint in endpoints" :key="endpointKey(endpoint)" :data-endpoint-key="endpointKey(endpoint)" type="button" role="listitem"
          :class="['ni-node', verifiedIdentity(endpoint) ? 'is-verified' : 'is-unknown', { 'is-selected': selectedEndpointKey === endpointKey(endpoint) }]"
          :aria-pressed="selectedEndpointKey === endpointKey(endpoint)" :aria-label="`${identityName(endpoint)}, ${endpoint.ipAddress}, ${verifiedIdentity(endpoint) ? 'verified identity' : 'unidentified'}`"
          @click="selectEndpoint(endpoint)">
          <span class="ni-node-symbol" aria-hidden="true">{{ verifiedIdentity(endpoint) ? '●' : '?' }}</span>
          <span class="ni-node-ip">{{ endpoint.ipAddress }}</span>
          <span class="ni-node-name">{{ identityName(endpoint) }} · {{ lifecycleLabel(endpointLifecycle(endpoint)) }}</span>
        </button>
      </div>
      <div v-else class="ni-empty-scope"><strong>No endpoints are recorded for this network in the latest snapshot.</strong><span>This means no endpoints were detected in this run; it does not establish that the network has no devices.</span></div>
      <p class="ni-note">Grouped by observed network. Physical links and wired or Wi-Fi attachment are not established by this view.</p>
      <div v-if="comparison && comparison.comparableScopes.includes(selectedScopeId)" class="ni-change-summary" aria-label="Changes since previous comparable scan">
        <strong>Since the previous scan</strong>
        <span>{{ comparison.addedEndpoints.filter(item => item.scopeId === selectedScopeId).length }} new</span>
        <span>{{ comparison.notDetectedEndpoints.filter(item => item.scopeId === selectedScopeId).length }} not detected <small>· not necessarily offline</small></span>
        <span v-if="comparison.verifiedAddressChanges.length">{{ comparison.verifiedAddressChanges.length }} verified IP change{{ comparison.verifiedAddressChanges.length === 1 ? '' : 's' }}</span>
        <span v-if="comparison.ipReuse.filter(item => item.scopeId === selectedScopeId).length">{{ comparison.ipReuse.filter(item => item.scopeId === selectedScopeId).length }} identity conflict{{ comparison.ipReuse.filter(item => item.scopeId === selectedScopeId).length === 1 ? '' : 's' }}</span>
      </div>
    </section>

    <section v-if="latest" class="ni-inventory" aria-labelledby="ni-inventory-title">
      <div class="ni-section-heading ni-inventory-heading">
        <div><h2 id="ni-inventory-title">Devices and endpoints</h2><p>Choose an item to inspect its evidence.</p></div>
        <label class="ni-search"><span class="sr-only">Search devices and endpoints</span><input v-model="search" type="search" placeholder="Search name, IP, or identity" /></label>
      </div>
      <div class="ni-inventory-controls">
        <div class="ni-filters" role="group" aria-label="Filter endpoints by identity">
          <button v-for="filter in ([['all','All'], ['verified','Verified'], ['unidentified','Unidentified']] as const)" :key="filter[0]" type="button" :aria-pressed="identityFilter === filter[0]" :class="{ active: identityFilter === filter[0] }" @click="identityFilter = filter[0]">{{ filter[1] }}</button>
        </div>
      </div>
      <div class="ni-content-grid">
        <div class="ni-device-list" role="list" aria-label="Network device inventory" tabindex="0">
          <button v-for="endpoint in visibleEndpoints" :key="endpointKey(endpoint)" :data-endpoint-key="endpointKey(endpoint)" type="button" role="listitem" :class="['ni-device-row', { active: selectedEndpointKey === endpointKey(endpoint) }]" :aria-pressed="selectedEndpointKey === endpointKey(endpoint)" @click="selectEndpoint(endpoint)">
            <span :class="['ni-device-icon', verifiedIdentity(endpoint) ? 'is-verified' : 'is-unknown']" aria-hidden="true">{{ verifiedIdentity(endpoint) ? '◉' : '?' }}</span>
            <span class="ni-device-main"><strong>{{ identityName(endpoint) }}</strong><span>{{ endpoint.ipAddress }}<template v-if="endpoint.vendor"> · {{ endpoint.vendor }}</template></span></span>
            <span class="ni-device-meta"><span :class="['ni-identity-label', verifiedIdentity(endpoint) ? 'is-verified' : 'is-unknown']">{{ lifecycleLabel(endpointLifecycle(endpoint)) }}</span><span>{{ date(endpoint.discoveredAt) }}</span></span>
            <span class="ni-device-services">{{ endpointServices(endpoint).join(', ') || 'No services identified' }}</span>
            <span class="ni-chevron" aria-hidden="true">›</span>
          </button>
          <p v-if="visibleEndpoints.length === 0" class="ni-empty-list">No endpoints match this filter. Try another filter or search.</p>
        </div>

        <button v-if="selectedEndpoint && mobileViewport && mobileDetailsOpen" type="button" class="ni-detail-scrim" aria-label="Close endpoint details" @click="closeDetails" />
        <aside v-if="selectedEndpoint && (!mobileViewport || mobileDetailsOpen)" class="ni-detail" aria-labelledby="ni-detail-title" :role="mobileViewport ? 'dialog' : undefined" :aria-modal="mobileViewport ? 'true' : undefined" :aria-label="`${identityName(selectedEndpoint)} endpoint details`" tabindex="-1" @keydown.esc="closeDetails">
          <div class="ni-detail-head">
            <div><span :class="['ni-identity-label', verifiedIdentity(selectedEndpoint) ? 'is-verified' : 'is-unknown']">{{ lifecycleLabel(endpointLifecycle(selectedEndpoint)) }}</span><h3 id="ni-detail-title">{{ identityName(selectedEndpoint) }}</h3></div>
            <button type="button" class="ni-detail-close" aria-label="Close endpoint details" @click="closeDetails">×</button>
          </div>
          <div v-if="lifecycleFor(selectedEndpoint)?.stage === 'pending'" class="ni-lifecycle-context">
            <span>Matched to an existing pending enrollment record by verified protocol identity.</span>
            <button type="button" @click="emit('openPending', lifecycleFor(selectedEndpoint)?.recordId)">Open pending record ›</button>
          </div>
          <div v-else-if="lifecycleFor(selectedEndpoint)?.stage === 'enrolled'" class="ni-lifecycle-context">
            <span>{{ lifecycleFor(selectedEndpoint)?.relatedRecords && lifecycleFor(selectedEndpoint)!.relatedRecords! > 1 ? `${lifecycleFor(selectedEndpoint)!.relatedRecords} enrolled logical records share this verified physical identity.` : 'Matched to an enrolled device by verified protocol identity.' }}</span>
            <button type="button" @click="emit('openDevice', lifecycleFor(selectedEndpoint)?.recordId || '')">Open device record ›</button>
          </div>
          <div v-else-if="endpointLifecycle(selectedEndpoint) === 'identified'" class="ni-lifecycle-context">
            <span>Identity is verified, but no pending or enrolled record is correlated.</span>
          </div>
          <div v-else-if="endpointLifecycle(selectedEndpoint) === 'approved'" class="ni-lifecycle-context">
            <span>Energrid approval exists; active enrollment is not confirmed.</span>
            <button type="button" @click="emit('openDevice', lifecycleFor(selectedEndpoint)?.recordId || '')">Open device record ›</button>
          </div>
          <dl class="ni-detail-fields">
            <div><dt>IP address</dt><dd>{{ selectedEndpoint.ipAddress }}</dd></div>
            <div><dt>Network</dt><dd>{{ selectedEndpoint.networkZoneName }} · {{ selectedEndpoint.networkZoneId }}</dd></div>
            <div><dt>Verified protocol identity</dt><dd>{{ verifiedIdentity(selectedEndpoint) ? selectedEndpoint.id : 'Not established' }}</dd></div>
            <div><dt>Observed MAC</dt><dd>{{ selectedEndpoint.macAddress || 'Not observed' }}</dd></div>
            <div v-if="selectedEndpoint.deviceReportedMacAddress"><dt>Device-reported MAC</dt><dd>{{ selectedEndpoint.deviceReportedMacAddress }}</dd></div>
            <div><dt>Services</dt><dd>{{ endpointServices(selectedEndpoint).join(', ') || 'No services identified' }}</dd></div>
            <div><dt>Last observed</dt><dd>{{ date(selectedEndpoint.discoveredAt) }}</dd></div>
            <div><dt>Collector</dt><dd>{{ latest.collector.host }} · {{ latest.collector.interfaces.join(', ') || 'interface unknown' }}</dd></div>
          </dl>
          <p class="ni-detail-reason">{{ selectedEndpoint.reason }}</p>
          <section v-if="!verifiedIdentity(selectedEndpoint)" class="ni-endpoint-investigation" aria-label="AI device investigation">
            <div class="ni-ai-heading"><strong>✦ AI Device Investigator</strong><span>Snapshot evidence only · read-only</span></div>
            <p v-if="selectedEndpoint.identityConflict" role="status">Conflicting identity evidence is present. Keep these records separate and resolve the conflict with independent evidence.</p>
            <template v-else>
              <button type="button" class="ni-investigate-button" :disabled="selectedInvestigation?.loading" @click="investigateSelectedEndpoint">
                {{ selectedInvestigation?.loading ? 'Investigating…' : selectedInvestigation?.result ? 'Investigate again' : 'Investigate with AI' }}
              </button>
              <p v-if="selectedInvestigation?.error" class="ni-investigation-error" role="alert">{{ selectedInvestigation.error }}</p>
              <div v-if="selectedInvestigation?.result" class="ni-investigation-result" aria-live="polite">
                <p class="ni-investigation-summary">{{ selectedInvestigation.result.summary }}</p>
                <div class="ni-investigation-identification">
                  <strong v-if="selectedInvestigation.result.identification.deviceType || selectedInvestigation.result.identification.manufacturer">
                    Possible {{ [selectedInvestigation.result.identification.manufacturer, selectedInvestigation.result.identification.deviceType].filter(Boolean).join(' ') }}
                  </strong>
                  <strong v-else>Not enough evidence to identify this device.</strong>
                  <span v-if="selectedInvestigation.result.identification.confidence !== null">Estimated confidence {{ Math.round(selectedInvestigation.result.identification.confidence * 100) }}%</span>
                  <span>{{ selectedInvestigation.result.identification.uncertainty }}</span>
                  <small v-if="selectedInvestigation.result.identification.supportingEvidenceIds.length">Supported by: {{ selectedInvestigation.result.identification.supportingEvidenceIds.map(evidenceLabel).join('; ') }}</small>
                </div>
                <ul v-if="selectedInvestigation.result.findings.length" class="ni-investigation-findings">
                  <li v-for="(finding, index) in selectedInvestigation.result.findings" :key="`${finding.claim}:${index}`">
                    <span>{{ finding.claim }}</span>
                    <small>{{ finding.supportingEvidenceIds.map(evidenceLabel).join('; ') }}</small>
                  </li>
                </ul>
                <div v-if="selectedInvestigation.result.missingEvidence.length" class="ni-investigation-gaps">
                  <strong>Missing evidence</strong><span>{{ selectedInvestigation.result.missingEvidence.join(' · ') }}</span>
                </div>
                <div v-if="selectedInvestigation.result.safeFollowUpChecks.length" class="ni-investigation-followups">
                  <strong>Suggested safe checks</strong>
                  <ul><li v-for="check in selectedInvestigation.result.safeFollowUpChecks" :key="check.action">{{ safeCheckLabel(check.action) }} <small>· human approval required</small></li></ul>
                </div>
                <small class="ni-investigation-provenance">Based on saved snapshot {{ selectedInvestigation.result.scanId }} · {{ date(selectedInvestigation.result.createdAt) }} · {{ selectedInvestigation.result.provider }} / {{ selectedInvestigation.result.model }}</small>
              </div>
            </template>
          </section>
          <details class="ni-evidence">
            <summary>Evidence details</summary>
            <ul v-if="selectedEndpoint.observations?.length"><li v-for="item in selectedEndpoint.observations" :key="`${item.source}:${item.attribute}:${item.observedAt}`"><strong>{{ item.attribute }}</strong><span>{{ item.source }}<template v-if="item.method"> · {{ item.method }}</template></span><small>{{ date(item.observedAt) }}</small></li></ul>
            <p v-else>No detailed observations were attached to this endpoint record.</p>
          </details>
        </aside>
      </div>
    </section>

    <section v-else class="ni-first-scan" aria-live="polite">
      <div class="ni-first-scan-icon" aria-hidden="true">⌕</div>
      <h2>{{ busy ? 'Discovering your network' : 'Your network view starts with a scan' }}</h2>
      <p>{{ busy ? 'Collecting bounded evidence for the selected scope. You can cancel the scan at any time.' : 'Select a configured network and run an approved scan. Results and history will appear here.' }}</p>
      <p v-if="availableScopes.length === 0">No configured network scopes are available. No scan has been run.</p>
    </section>

    <details class="ni-diagnostics" :open="diagnosticsOpen" @toggle="diagnosticsOpen = ($event.target as HTMLDetailsElement).open">
      <summary>Diagnostics and coverage <span>Interfaces, routes, tools, and collection limits</span></summary>
      <div v-if="observer" class="ni-diagnostics-grid">
        <section><h3>Observer</h3><p>{{ observer.observer.host }} · {{ observer.observer.platform }} · inspected {{ date(observer.observedAt) }}</p></section>
        <section><h3>Interfaces</h3><ul><li v-for="item in observer.interfaces" :key="item.name"><strong>{{ item.name }}</strong><span v-for="address in item.addresses" :key="`${item.name}:${address.address}`">{{ address.address }}<template v-if="address.prefixLength !== undefined">/{{ address.prefixLength }}</template><template v-if="address.netmask"> · {{ address.netmask }}</template></span><small v-if="item.macAddress">Interface MAC · {{ item.macAddress }}</small></li></ul></section>
        <section><h3>Routes</h3><ul><li v-for="route in observer.routes" :key="`${route.destination}:${route.interfaceName}:${route.gateway}`"><strong>{{ route.destination }}</strong><span>{{ route.gateway ? `via ${route.gateway}` : 'gateway not reported' }} · {{ route.interfaceName || 'interface unknown' }}</span><small>{{ route.evidence }}</small></li></ul></section>
        <section><h3>Configured scopes</h3><ul><li v-for="scope in observer.configuredScopes" :key="scope.id"><strong>{{ scope.name }} · {{ scope.cidr || 'unscoped' }}</strong><span>{{ scope.reachability.replace('_', ' ') }} · {{ scope.boundedScanEligible ? 'eligible for approved bounded scan' : 'not eligible' }}</span><small>{{ scope.reason }}</small></li></ul></section>
        <section><h3>Collector capabilities</h3><ul><li v-for="capability in observer.capabilities" :key="capability.id"><strong>{{ capability.id }} · {{ capability.available ? 'available' : 'unavailable' }}</strong><span>{{ capability.detail }}</span></li></ul><p v-if="nmapCapability">Nmap {{ nmapCapability.available ? `${nmapCapability.version || 'version unknown'} available` : `unavailable · ${nmapCapability.reason || 'not detected'}` }} · {{ nmapCapability.enabled ? 'scanning enabled' : 'scanning disabled' }}</p></section>
        <section v-if="latest"><h3>Snapshot collection</h3><p>Schema v{{ latest.schemaVersion }} · {{ latest.scanId }} · {{ latest.methods.join(', ') }}</p><p>{{ latest.successes }} successful collection result(s) · {{ latest.failures.length }} failure(s)</p><ul v-if="latest.failures.length"><li v-for="failure in latest.failures" :key="failure">{{ failure }}</li></ul></section>
        <section v-if="latest?.limitations.length"><h3>Coverage limitations</h3><ul><li v-for="limitation in latest.limitations" :key="limitation">{{ limitation }}</li></ul></section>
        <section v-if="latest"><h3>Snapshot history</h3><p>{{ snapshots.length }} immutable scan{{ snapshots.length === 1 ? '' : 's' }} preserved</p><p>Topology links: {{ latest.topology.relationships.length ? `${latest.topology.relationships.length} evidence-backed relationship(s)` : 'none established' }}</p></section>
      </div>
      <p v-else class="ni-diagnostics-empty">Observer diagnostics have not been loaded.</p>
    </details>
  </main>
</template>

<style scoped>
.network-intelligence-page {
  --ni-bg: #fff;
  --ni-surface: #f5f7fa;
  --ni-surface-raised: #fff;
  --ni-border: #d9e0e9;
  --ni-text: #172033;
  --ni-muted: #5e6b7e;
  --ni-accent: #2863e6;
  --ni-accent-soft: #eaf1ff;
  --ni-unknown: #52647b;
  --ni-unknown-soft: #edf1f6;
  --ni-success: #16764d;
  --ni-success-soft: #e7f7ee;
  display: grid;
  gap: 22px;
  width: min(100%, 1320px);
  margin: 0 auto;
  padding: clamp(12px, 2vw, 28px);
  color: var(--ni-text);
}
.ni-header, .ni-header-actions, .ni-status-row, .ni-section-heading, .ni-inventory-heading, .ni-device-row, .ni-detail-head { display: flex; align-items: center; }
.ni-header { justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.ni-eyebrow { margin: 0 0 5px; color: var(--ni-accent); font-size: 12px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
.ni-header h1 { margin: 0; font-size: clamp(28px, 3vw, 38px); letter-spacing: -.035em; line-height: 1.1; }
.ni-subtitle { margin: 8px 0 0; color: var(--ni-muted); font-size: 15px; }
.ni-header-actions { gap: 12px; flex-wrap: wrap; }
.ni-scope-select { display: grid; gap: 5px; min-width: min(320px, 80vw); color: var(--ni-muted); font-size: 12px; font-weight: 650; }
.ni-scope-select select, .ni-search input { min-height: 42px; border: 1px solid var(--ni-border); border-radius: 10px; padding: 0 12px; color: var(--ni-text); background: var(--ni-surface); font: inherit; }
.ni-scope-select select { max-width: min(420px, 80vw); }
.ni-button { min-height: 44px; border: 1px solid var(--ni-border); border-radius: 10px; padding: 0 18px; color: var(--ni-text); background: var(--ni-surface); font: inherit; font-weight: 700; cursor: pointer; }
.ni-button-primary { border-color: #2863e6; color: #fff; background: #2863e6; }
.ni-button-primary:hover:not(:disabled) { border-color: #1f51c2; background: #1f51c2; }
.ni-button:disabled { cursor: not-allowed; opacity: .58; }
.ni-status-row { gap: 12px; min-height: 24px; flex-wrap: wrap; }
.ni-status-pill, .ni-identity-label { display: inline-flex; gap: 6px; align-items: center; width: fit-content; border-radius: 999px; padding: 5px 10px; font-size: 12px; font-weight: 750; white-space: nowrap; }
.ni-status-pill.is-complete, .ni-identity-label.is-verified { color: var(--ni-success); background: var(--ni-success-soft); }
.ni-status-pill.is-partial { color: #9a5b00; background: #fff2d6; }
:global(.theme-dark) .ni-status-pill.is-partial { color: #ffd27c; background: #443316; }
.ni-status-pill.is-neutral { color: var(--ni-muted); background: var(--ni-surface); }
.ni-last-scan { color: var(--ni-muted); font-size: 13px; }
.ni-error { flex-basis: 100%; margin: 0; color: #c53131; }
.ni-lifecycle-links { display: flex; align-items: stretch; gap: 9px; flex-wrap: wrap; }
.ni-lifecycle-link { display: inline-grid; grid-template-columns: auto auto auto; align-items: center; gap: 9px; min-height: 40px; border: 1px solid var(--ni-border); border-radius: 10px; padding: 5px 11px; color: var(--ni-text); background: var(--ni-surface-raised); text-align: left; cursor: pointer; }
.ni-lifecycle-link:hover { border-color: var(--ni-accent); background: var(--ni-accent-soft); }
.ni-lifecycle-link > span:first-child { color: var(--ni-muted); font-size: 12px; font-weight: 650; }
.ni-lifecycle-link > strong { min-width: 1.4em; color: var(--ni-text); font-size: 15px; font-variant-numeric: tabular-nums; text-align: center; }
.ni-lifecycle-destination { color: var(--ni-accent); font-size: 11px; font-weight: 700; }
.ni-lifecycle-unavailable { align-self: center; color: var(--ni-muted); font-size: 12px; }
.ni-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.ni-metrics article { display: grid; gap: 5px; min-width: 0; padding: 17px 18px; border: 1px solid var(--ni-border); border-radius: 14px; background: var(--ni-surface); }
.ni-metrics strong { font-size: clamp(27px, 3vw, 36px); font-weight: 750; line-height: 1; font-variant-numeric: tabular-nums; }
.ni-metrics span { color: var(--ni-muted); font-size: 13px; }
.ni-overview, .ni-inventory, .ni-diagnostics, .ni-first-scan { min-width: 0; border: 1px solid var(--ni-border); border-radius: 16px; background: var(--ni-bg); }
.ni-overview, .ni-inventory { padding: clamp(14px, 2vw, 22px); }
.ni-section-heading { justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 15px; }
.ni-section-heading h2 { margin: 0 0 4px; font-size: 19px; letter-spacing: -.01em; }
.ni-section-heading p, .ni-section-heading > span { margin: 0; color: var(--ni-muted); font-size: 13px; }
.ni-explorer { display: grid; grid-template-columns: repeat(auto-fill, minmax(116px, 1fr)); gap: 12px; min-height: 126px; padding: 16px; border: 1px solid var(--ni-border); border-radius: 13px; background: var(--ni-surface); }
.ni-node { display: grid; justify-items: center; gap: 5px; min-width: 0; min-height: 105px; border: 1px solid var(--ni-border); border-radius: 13px; padding: 11px 7px; color: var(--ni-text); background: var(--ni-surface-raised); cursor: pointer; transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; }
.ni-node:hover { transform: translateY(-2px); }
.ni-node.is-verified { border-color: color-mix(in srgb, var(--ni-accent) 65%, var(--ni-border)); }
.ni-node.is-selected { box-shadow: 0 0 0 2px var(--ni-accent); }
.ni-node-symbol { display: grid; width: 42px; height: 42px; place-items: center; border: 2px solid var(--ni-unknown); border-radius: 13px; color: var(--ni-unknown); background: var(--ni-unknown-soft); font-size: 22px; }
.ni-node.is-verified .ni-node-symbol { border-color: var(--ni-accent); color: var(--ni-accent); background: var(--ni-accent-soft); }
.ni-node-ip { font-size: 12px; font-weight: 750; font-variant-numeric: tabular-nums; }
.ni-node-name { max-width: 100%; overflow: hidden; color: var(--ni-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.ni-note { margin: 10px 0 0; color: var(--ni-muted); font-size: 12px; }
.ni-change-summary { display: flex; gap: 8px 14px; align-items: center; flex-wrap: wrap; margin-top: 16px; padding: 12px 14px; border-left: 3px solid var(--ni-accent); border-radius: 5px; background: var(--ni-surface); font-size: 13px; }
.ni-change-summary strong { margin-right: 4px; }
.ni-change-summary span { color: var(--ni-muted); }
.ni-change-summary small { color: var(--ni-muted); }
.ni-inventory-heading { margin-bottom: 10px; }
.ni-inventory-controls { position: sticky; top: 0; z-index: 3; margin-bottom: 2px; padding: 5px 0 10px; background: var(--ni-bg); }
.ni-search input { width: min(320px, 80vw); }
.ni-filters { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
.ni-filters button { min-height: 35px; border: 1px solid var(--ni-border); border-radius: 999px; padding: 0 12px; color: var(--ni-muted); background: var(--ni-surface); cursor: pointer; }
.ni-filters button.active { border-color: var(--ni-accent); color: var(--ni-text); box-shadow: inset 0 0 0 1px var(--ni-accent); }
.ni-content-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(280px, .85fr); gap: 14px; align-items: stretch; height: min(58vh, 520px); min-height: 360px; }
.ni-device-list { display: grid; gap: 7px; min-width: 0; height: 100%; box-sizing: border-box; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; border: 1px solid var(--ni-border); border-radius: 13px; padding: 9px; background: var(--ni-surface); }
.ni-device-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) minmax(150px, auto) 20px; grid-template-areas: 'icon main meta arrow' 'icon service meta arrow'; gap: 3px 10px; width: 100%; min-height: 68px; border: 1px solid var(--ni-border); border-radius: 12px; padding: 10px 12px; color: var(--ni-text); text-align: left; background: var(--ni-bg); cursor: pointer; }
.ni-device-row:hover, .ni-device-row.active { border-color: var(--ni-accent); background: var(--ni-surface); }
.ni-device-icon { grid-area: icon; align-self: center; display: grid; width: 34px; height: 34px; place-items: center; border-radius: 10px; font-weight: 750; }
.ni-device-icon.is-verified { color: var(--ni-accent); background: var(--ni-accent-soft); }
.ni-device-icon.is-unknown { color: var(--ni-unknown); background: var(--ni-unknown-soft); }
.ni-device-main { grid-area: main; display: grid; gap: 3px; min-width: 0; }
.ni-device-main strong { overflow-wrap: anywhere; font-size: 13px; }
.ni-device-main > span, .ni-device-services { overflow: hidden; color: var(--ni-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.ni-device-meta { grid-area: meta; display: grid; justify-items: end; gap: 5px; align-content: center; color: var(--ni-muted); font-size: 11px; text-align: right; }
.ni-device-meta > span:last-child { font-variant-numeric: tabular-nums; }
.ni-identity-label.is-unknown { color: var(--ni-unknown); background: var(--ni-unknown-soft); }
.ni-device-meta .ni-identity-label { font-size: 10px; padding: 4px 8px; }
.ni-device-services { grid-area: service; }
.ni-chevron { grid-area: arrow; align-self: center; color: var(--ni-muted); font-size: 23px; }
.ni-detail { position: sticky; top: 18px; min-width: 0; height: 100%; max-height: 100%; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--ni-border); border-radius: 13px; padding: 15px; background: var(--ni-surface); }
.ni-lifecycle-context { display: grid; gap: 8px; margin-top: 13px; border: 1px solid var(--ni-border); border-radius: 10px; padding: 10px; color: var(--ni-muted); background: var(--ni-bg); font-size: 12px; line-height: 1.45; }
.ni-lifecycle-context button { justify-self: start; min-height: 30px; border: 0; padding: 0; color: var(--ni-accent); background: transparent; font-size: 12px; font-weight: 750; cursor: pointer; }
.ni-detail-scrim { display: none; }
.ni-detail-head { justify-content: space-between; gap: 10px; align-items: flex-start; }
.ni-detail-head h3 { margin: 7px 0 0; overflow-wrap: anywhere; font-size: 17px; }
.ni-detail-close { width: 34px; height: 34px; border: 1px solid var(--ni-border); border-radius: 9px; color: var(--ni-text); background: var(--ni-bg); font-size: 20px; cursor: pointer; }
.ni-detail-fields { display: grid; gap: 0; margin: 15px 0; }
.ni-detail-fields > div { display: grid; grid-template-columns: minmax(95px, .7fr) minmax(0, 1.3fr); gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--ni-border); }
.ni-detail-fields dt { color: var(--ni-muted); font-size: 12px; }
.ni-detail-fields dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 12px; font-weight: 600; }
.ni-detail-reason { margin: 0; color: var(--ni-muted); font-size: 12px; line-height: 1.5; }
.ni-endpoint-investigation { display: grid; gap: 10px; margin: 14px 0; padding: 13px; border: 1px solid var(--ni-border); border-radius: 12px; background: var(--ni-surface); }
.ni-ai-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; color: var(--ni-text); font-size: 13px; }
.ni-ai-heading strong { color: var(--ni-accent); }
.ni-ai-heading > span, .ni-investigation-provenance { color: var(--ni-muted); font-size: 11px; }
.ni-investigate-button { justify-self: start; min-height: 36px; border: 1px solid var(--ni-accent); border-radius: 9px; padding: 0 13px; color: #fff; background: var(--ni-accent); font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
.ni-investigate-button:hover:not(:disabled) { filter: brightness(.94); }
.ni-investigate-button:disabled { cursor: wait; opacity: .65; }
.ni-investigation-error { margin: 0; color: #b42318; font-size: 12px; }
.ni-investigation-result { display: grid; gap: 10px; min-width: 0; font-size: 12px; }
.ni-investigation-summary { margin: 0; color: var(--ni-text); line-height: 1.5; }
.ni-investigation-identification, .ni-investigation-gaps, .ni-investigation-followups { display: grid; gap: 5px; }
.ni-investigation-identification { padding: 10px; border-radius: 9px; background: var(--ni-surface-raised); }
.ni-investigation-identification > strong { color: var(--ni-text); font-size: 13px; }
.ni-investigation-identification > span, .ni-investigation-gaps > span { color: var(--ni-muted); line-height: 1.45; }
.ni-investigation-identification > small, .ni-investigation-findings small { color: var(--ni-muted); overflow-wrap: anywhere; line-height: 1.4; }
.ni-investigation-findings, .ni-investigation-followups ul { display: grid; gap: 8px; margin: 0; padding-left: 18px; }
.ni-investigation-findings li { display: grid; gap: 3px; color: var(--ni-text); }
.ni-investigation-gaps > strong, .ni-investigation-followups > strong { color: var(--ni-text); }
.ni-investigation-followups small { color: var(--ni-muted); }
.ni-investigation-provenance { overflow-wrap: anywhere; }
.ni-endpoint-investigation [role="status"] { margin: 0; color: var(--ni-muted); font-size: 12px; line-height: 1.45; }
.ni-evidence { margin-top: 13px; border-top: 1px solid var(--ni-border); padding-top: 11px; }
.ni-evidence summary, .ni-diagnostics summary { cursor: pointer; font-size: 13px; font-weight: 700; }
.ni-evidence ul, .ni-diagnostics ul { display: grid; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
.ni-evidence li, .ni-diagnostics li { display: grid; gap: 3px; overflow-wrap: anywhere; font-size: 12px; }
.ni-evidence li span, .ni-evidence li small, .ni-diagnostics li span, .ni-diagnostics li small { color: var(--ni-muted); }
.ni-empty-list { border: 1px dashed var(--ni-border); border-radius: 12px; padding: 18px; color: var(--ni-muted); font-size: 13px; }
.ni-empty-scope, .ni-first-scan { display: grid; justify-items: center; gap: 10px; padding: 34px 18px; text-align: center; }
.ni-empty-scope { border: 1px dashed var(--ni-border); border-radius: 13px; background: var(--ni-surface); }
.ni-empty-scope span, .ni-first-scan p { max-width: 560px; margin: 0; color: var(--ni-muted); line-height: 1.6; }
.ni-first-scan { min-height: 300px; align-content: center; }
.ni-first-scan h2 { margin: 0; font-size: 22px; }
.ni-first-scan-icon { display: grid; width: 56px; height: 56px; place-items: center; border: 1px solid var(--ni-border); border-radius: 18px; color: var(--ni-accent); background: var(--ni-accent-soft); font-size: 38px; }
.ni-diagnostics { padding: 0; overflow: hidden; background: var(--ni-surface); }
.ni-diagnostics > summary { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 55px; padding: 14px 17px; list-style-position: inside; }
.ni-diagnostics > summary span { color: var(--ni-muted); font-size: 12px; font-weight: 450; }
.ni-diagnostics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 0 17px 17px; }
.ni-diagnostics-grid section { min-width: 0; border: 1px solid var(--ni-border); border-radius: 11px; padding: 13px; background: var(--ni-bg); }
.ni-diagnostics-grid h3 { margin: 0 0 8px; font-size: 13px; }
.ni-diagnostics-grid p, .ni-diagnostics-grid li { color: var(--ni-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.ni-diagnostics-grid p { margin: 7px 0 0; }
.ni-diagnostics-grid li strong { color: var(--ni-text); }
.ni-diagnostics-empty { margin: 0; padding: 15px; color: var(--ni-muted); }
.network-intelligence-page :is(button, select, input, summary):focus-visible { outline: 3px solid var(--ni-accent); outline-offset: 3px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 900px) {
  .ni-content-grid { grid-template-columns: minmax(0, 1fr); height: auto; min-height: 0; }
  .ni-device-list { height: auto; max-height: min(52vh, 500px); }
  .ni-detail { position: static; height: auto; max-height: min(55vh, 520px); }
}
@media (max-width: 640px) {
  .network-intelligence-page { gap: 15px; padding: 12px; }
  .ni-header { align-items: flex-start; }
  .ni-header-actions { width: 100%; align-items: stretch; }
  .ni-scope-select { flex: 1 1 100%; min-width: 0; }
  .ni-scope-select select { width: 100%; max-width: none; }
  .ni-header-actions .ni-button { flex: 1; }
  .ni-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .ni-metrics article { padding: 13px; }
  .ni-explorer { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; padding: 10px; }
  .ni-node { min-height: 88px; padding: 8px 4px; }
  .ni-node-symbol { width: 34px; height: 34px; }
  .ni-device-row { grid-template-columns: 34px minmax(0, 1fr) 18px; grid-template-areas: 'icon main arrow' 'icon service arrow' 'meta meta meta'; gap: 4px 9px; }
  .ni-device-meta { grid-template-columns: 1fr; justify-items: start; text-align: left; padding-left: 43px; }
  .ni-device-meta .ni-identity-label { white-space: normal; }
  .ni-device-list { max-height: 56vh; }
  .ni-search, .ni-search input { width: 100%; }
  .ni-inventory-heading { align-items: flex-start; }
  .ni-diagnostics-grid { grid-template-columns: minmax(0, 1fr); }
  .ni-detail-fields > div { grid-template-columns: minmax(95px, .8fr) minmax(0, 1.2fr); }
  .ni-lifecycle-links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ni-lifecycle-link { grid-template-columns: auto auto; justify-content: space-between; }
  .ni-lifecycle-destination { grid-column: 1 / -1; }
  .ni-detail-scrim { display: block; position: fixed; inset: 0; z-index: 49; width: 100%; min-height: 100%; border: 0; border-radius: 0; padding: 0; background: rgb(9 17 31 / 54%); }
  .ni-detail { position: fixed; z-index: 50; inset: auto 0 0; width: min(100%, 680px); max-height: min(82dvh, 760px); margin: 0 auto; overflow-y: auto; border-radius: 20px 20px 0 0; padding: 20px 16px max(20px, env(safe-area-inset-bottom)); box-shadow: 0 -14px 44px rgb(15 23 42 / 20%); }
}
</style>
