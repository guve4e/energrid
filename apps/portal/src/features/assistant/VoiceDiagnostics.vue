<script setup lang="ts">
defineProps<{ bottleneck: string; serverMetrics: Array<{ label: string; value: string }>;
  clientMetrics: Array<{ label: string; value: string }> }>();
</script>
<template>
  <div class="diagnostics">
    <section><div class="section-row compact"><h2>Bottleneck</h2></div><p>{{ bottleneck }}</p></section>
    <section><div class="section-row compact"><h2>Server metrics</h2></div>
      <dl class="metric-grid"><div v-for="item in serverMetrics" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div></dl>
    </section>
    <section><div class="section-row compact"><h2>Browser trace</h2></div>
      <dl class="metric-grid"><div v-for="item in clientMetrics" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div></dl>
    </section>
  </div>
</template>
