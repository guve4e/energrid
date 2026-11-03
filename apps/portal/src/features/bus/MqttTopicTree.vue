<script setup lang="ts">
import type { MqttBusState, MqttTreeNode } from './mqtt-model';

defineProps<{
  bus: MqttBusState;
  nodes: MqttTreeNode[];
  selectedTopic: string;
  expandedTopics: Set<string>;
  filter: string;
}>();
const emit = defineEmits<{
  'update:filter': [value: string];
  select: [topic: string];
  toggle: [topic: string];
}>();
function onFilterInput(event: Event) {
  emit('update:filter', (event.target as HTMLInputElement).value);
}
</script>
<template>
              <aside class="mqtt-tree-panel" aria-label="MQTT topics">
                <div class="mqtt-toolbar">
                  <strong>{{ bus.broker.host }}</strong>
                  <input
                    :value="filter"
                    @input="onFilterInput"
                    class="compact-input"
                    placeholder="Search topics"
                  />
                </div>

                <div class="topic-chip-row compact-row">
                  <span v-for="topic in bus.subscriptions" :key="topic">{{
                    topic
                  }}</span>
                </div>

                <div
                  v-if="nodes.length === 0"
                  class="discovery-empty compact"
                >
                  <strong>No topic tree yet</strong>
                  <span
                    >Wait for retained or live MQTT messages to arrive from the
                    stream.</span
                  >
                </div>
                <div v-else class="mqtt-tree">
                  <button
                    v-for="node in nodes"
                    :key="node.key"
                    :class="[
                      'mqtt-tree-row',
                      { selected: selectedTopic === node.topic },
                    ]"
                    :style="{ '--topic-depth': node.depth }"
                    type="button"
                    @click="emit('select', node.topic)"
                  >
                    <span
                      class="mqtt-tree-toggle"
                      @click.stop="
                        node.childCount
                          ? emit('toggle', node.topic)
                          : emit('select', node.topic)
                      "
                    >
                      {{
                        node.childCount
                          ? expandedTopics.has(node.topic)
                            ? '▾'
                            : '▸'
                          : '•'
                      }}
                    </span>
                    <span class="mqtt-tree-label">{{ node.label }}</span>
                    <span
                      v-if="node.directMessageCount || node.messageCount"
                      class="mqtt-tree-count"
                    >
                      {{ node.directMessageCount || node.messageCount }}
                    </span>
                    <span
                      v-else-if="node.subscription"
                      class="mqtt-tree-count muted"
                      >sub</span
                    >
                  </button>
                </div>
              </aside>

</template>
