<template>
  <template v-if="trace">
    <div class="trace-modal-backdrop" @click="emit('close')"></div>

    <aside class="trace-modal">
      <div class="device-sheet-head">
        <div>
          <span class="eyebrow">Execution timeline</span>

          <h3>
            {{ trace.action }}
            ·
            {{ trace.outcome }}
          </h3>
        </div>

        <button class="icon-button" type="button" @click="emit('close')">
          ×
        </button>
      </div>

      <div class="execution-summary">
        <div>
          <small>ACTOR</small>
          <strong>
            {{ trace.actor?.name || trace.actor?.type || 'Unknown' }}
          </strong>
        </div>

        <div>
          <small>DEVICE</small>
          <strong>{{ trace.deviceId }}</strong>
        </div>

        <div>
          <small>DURATION</small>
          <strong>
            {{ trace.durationMs != null ? `${trace.durationMs}ms` : 'running' }}
          </strong>
        </div>
      </div>

      <ExecutionSimulator :trace="trace" />
    </aside>
  </template>
</template>

<script setup lang="ts">
import ExecutionSimulator from './ExecutionSimulator.vue';

defineProps<{
  trace: {
    action: string;
    outcome: string;
    deviceId: string;
    durationMs: number | null;
    actor?: {
      type: string;
      name?: string;
    };
    stages: Array<{
      stage: string;
      status: string;
      message: string;
      observedAt: string;
    }>;
  } | null;
}>();

const emit = defineEmits<{
  close: [];
}>();
</script>
