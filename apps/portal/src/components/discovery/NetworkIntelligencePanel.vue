<script setup lang="ts">
import { ref, watch } from 'vue';

type Scope = { id: string; name: string; cidr?: string; interfaceName?: string; seedIps: string[] };
type Endpoint = {
  id: string; ipAddress: string; networkZoneId: string; networkZoneName: string;
  macAddress?: string; deviceReportedMacAddress?: string; hostname?: string; vendor?: string;
  model?: string; protocol: string; status: string; discoveredAt: string; reason: string;
  observations?: Array<{ source: string; attribute: string; value: string | number | boolean; observedAt: string }>;
};
type Snapshot = {
  scanId: string; schemaVersion: number; startedAt: string; completedAt: string;
  collector: { id: string; host: string; interfaces: string[] };
  scopes: Array<{ id: string; name: string; cidr?: string; interfaceName?: string; complete: boolean; gatewayIpsObserved: string[] }>;
  methods: string[]; successes: number; failures: string[]; limitations: string[]; endpoints: Endpoint[];
  topology: { relationships: Array<{ from: string; to: string; relation: string; verification: string; evidence: string[] }> };
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

const props = defineProps<{
  scopes: Scope[]; snapshots: Snapshot[]; latest: Snapshot | null; comparison: Diff | null;
  busy?: boolean; error?: string;
}>();
const emit = defineEmits<{ scan: [scopeIds: string[]] }>();
const selectedScopeIds = ref<string[]>([]);
watch(() => props.scopes, scopes => {
  const available = new Set(scopes.map(scope => scope.id));
  selectedScopeIds.value = selectedScopeIds.value.filter(id => available.has(id));
  if (!selectedScopeIds.value.length) selectedScopeIds.value = scopes.map(scope => scope.id);
}, { immediate: true, deep: true });

const services = (endpoint: Endpoint) => [...new Set((endpoint.observations || [])
  .filter(observation => observation.source === 'tcp' && observation.value === true)
  .map(observation => observation.attribute.replace(/^port\./, '').replace(/\.open$/, '')))];
const rpcVerified = (endpoint: Endpoint) => endpoint.vendor === 'Shelly' && endpoint.protocol === 'http' && /^shelly[a-z0-9._-]+$/i.test(endpoint.id);
const date = (value: string) => new Date(value).toLocaleString();
</script>

<template>
  <section class="panel network-intelligence-panel" aria-labelledby="network-intelligence-title">
    <div class="section-row">
      <div>
        <p class="eyebrow">Network Intelligence</p>
        <h3 id="network-intelligence-title">Network snapshots</h3>
        <span class="section-help">Each completed scan is preserved. “Not detected” never means offline.</span>
      </div>
      <button type="button" class="primary" :disabled="busy || selectedScopeIds.length === 0" @click="emit('scan', [...selectedScopeIds])">
        {{ busy ? 'Discovering…' : 'Discover selected networks' }}
      </button>
    </div>
    <fieldset class="network-scope-picker">
      <legend>Choose scan scope</legend>
      <label v-for="scope in scopes" :key="scope.id">
        <input v-model="selectedScopeIds" type="checkbox" :value="scope.id" />
        <span>{{ scope.name }}<small>{{ scope.cidr || 'Seeded endpoints only' }}</small></span>
      </label>
      <small>Subnet scans use bounded ICMP/TCP probes (up to 254 hosts per configured subnet). The next step asks for confirmation before scanning.</small>
    </fieldset>
    <p v-if="error" role="alert">{{ error }}</p>

    <div v-if="latest" class="snapshot-summary">
      <div class="section-row"><div><strong>Latest snapshot</strong><span class="section-help">{{ latest.scanId }} · schema v{{ latest.schemaVersion }}</span></div><span>{{ latest.endpoints.length }} endpoints</span></div>
      <dl>
        <div><dt>Completed</dt><dd>{{ date(latest.completedAt) }}</dd></div>
        <div><dt>Observed from</dt><dd>{{ latest.collector.host }} · {{ latest.collector.interfaces.join(', ') || 'interface not identified' }}</dd></div>
        <div><dt>Methods</dt><dd>{{ latest.methods.join(', ') }}</dd></div>
        <div><dt>Snapshot history</dt><dd>{{ snapshots.length }} immutable scans available</dd></div>
        <div><dt>Topology</dt><dd>{{ latest.topology.relationships.length ? `${latest.topology.relationships.length} evidenced relationships` : 'No link relationships established' }}</dd></div>
      </dl>
      <div class="snapshot-scopes" aria-label="Observed network scopes">
        <article v-for="scope in latest.scopes" :key="scope.id">
          <strong>{{ scope.name }}</strong><span>{{ scope.cidr || 'Address scope not established' }}</span>
          <small>Collector interface: {{ scope.interfaceName || 'not established' }}</small>
          <small>Gateway addresses observed: {{ scope.gatewayIpsObserved.join(', ') || 'not established' }}</small>
          <small>{{ scope.complete ? 'Configured address range swept' : 'Coverage incomplete or not enumerable' }}</small>
        </article>
      </div>
      <p v-for="limitation in latest.limitations" :key="limitation" class="section-help">Coverage limitation: {{ limitation }}</p>
      <div v-if="comparison" class="snapshot-diff" aria-label="Comparison with previous equivalent scan">
        <strong>Compared with {{ comparison.fromScanId }}</strong>
        <span>{{ comparison.addedEndpoints.length }} new endpoint(s)</span>
        <span>{{ comparison.notDetectedEndpoints.length }} not detected</span>
        <span>{{ comparison.verifiedAddressChanges.length }} verified IP change(s)</span>
        <span>{{ comparison.ipReuse.length }} IP reuse conflict(s)</span>
        <span v-if="comparison.incompleteScopes.length">Incomplete scopes: {{ comparison.incompleteScopes.join(', ') }}</span>
        <ul v-if="comparison.verifiedAddressChanges.length || comparison.ipReuse.length">
          <li v-for="change in comparison.verifiedAddressChanges" :key="change.identity">{{ change.identity }} moved {{ change.from }} → {{ change.to }}</li>
          <li v-for="change in comparison.ipReuse" :key="`${change.scopeId}:${change.ipAddress}`">{{ change.ipAddress }} has changed identity evidence in {{ change.scopeId }}</li>
        </ul>
      </div>
      <div class="network-table-wrap">
        <table class="network-table">
          <thead><tr><th>Scope / IP</th><th>Observed MAC</th><th>Hostname / identity</th><th>Services</th><th>Evidence</th></tr></thead>
          <tbody>
            <tr v-for="endpoint in latest.endpoints" :key="`${endpoint.networkZoneId}:${endpoint.ipAddress}:${endpoint.macAddress || endpoint.id}`">
              <td>{{ endpoint.networkZoneName }}<strong>{{ endpoint.ipAddress }}</strong></td>
              <td>{{ endpoint.macAddress || 'Not observed' }}<small v-if="endpoint.deviceReportedMacAddress">Device-reported: {{ endpoint.deviceReportedMacAddress }}</small></td>
              <td>{{ endpoint.hostname || 'Hostname unknown' }}<small>{{ rpcVerified(endpoint) ? `RPC verified: ${endpoint.id}` : endpoint.id }}</small></td>
              <td>{{ services(endpoint).join(', ') || 'Not detected' }}</td>
              <td>{{ endpoint.reason }}<small>{{ endpoint.observations?.map(item => `${item.source}:${item.attribute}`).join(', ') || 'No detailed evidence references' }}</small><small>{{ date(endpoint.discoveredAt) }}</small></td>
            </tr>
            <tr v-if="latest.endpoints.length === 0"><td colspan="5">No endpoints were detected in this snapshot.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-else class="discovery-empty compact"><strong>No network snapshots yet</strong><span>Choose one or more networks and start a confirmed discovery run.</span></div>
  </section>
</template>

<style scoped>
.network-intelligence-panel { display: grid; gap: 16px; }
.network-scope-picker { display: flex; flex-wrap: wrap; gap: 12px 20px; border: 1px solid var(--discovery-border, #d8e0ec); border-radius: 8px; padding: 12px; }
.network-scope-picker legend { padding: 0 6px; font-weight: 600; }
.network-scope-picker label { display: flex; gap: 8px; align-items: flex-start; }
.network-scope-picker label span, .network-scope-picker label small { display: block; }
.network-scope-picker small, .snapshot-summary small { color: var(--discovery-muted, #52636b); }
.network-scope-picker > small { flex-basis: 100%; }
.snapshot-summary { display: grid; gap: 12px; }
.snapshot-scopes { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
.snapshot-scopes article { display: grid; gap: 4px; padding: 10px; border: 1px solid var(--discovery-border, #d8e0ec); border-radius: 8px; }
.snapshot-scopes span { font-variant-numeric: tabular-nums; }
.snapshot-summary dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 0; }
.snapshot-summary dt { font-size: 11px; color: var(--discovery-muted, #52636b); }
.snapshot-summary dd { margin: 4px 0 0; overflow-wrap: anywhere; font-size: 12px; }
.snapshot-diff { display: flex; flex-wrap: wrap; gap: 8px 14px; border-left: 3px solid var(--discovery-accent, #20ac7c); padding: 8px 12px; }
.snapshot-diff ul { flex-basis: 100%; margin: 0; }
.network-table small { display: block; margin-top: 4px; }
</style>
