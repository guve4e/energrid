<script setup lang="ts">
import type { PortalState } from '../../portal-state';
defineProps<{ systems: NonNullable<PortalState['systems']> }>();
</script>
<template>
        <section
          class="panel workspace-panel"
        >
          <div class="page-heading">
            <p class="eyebrow">Site Intelligence</p>
            <h2>Systems</h2>
            <span
              >Higher-level things the assistant can reason about: climate
              layers, inventory vision, forecast learning, and future energy
              behavior.</span
            >
          </div>

          <div class="system-grid">
            <article
              v-for="system in systems"
              :key="system.id"
              class="system-card"
            >
              <div class="system-card-head">
                <div>
                  <span>{{ system.kind.replaceAll('_', ' ') }}</span>
                  <h3>{{ system.displayName }}</h3>
                </div>
                <strong
                  >{{
                    Math.round(system.learning.currentConfidence * 100)
                  }}%</strong
                >
              </div>
              <p>{{ system.learning.objective }}</p>
              <dl class="device-facts">
                <div>
                  <dt>Capabilities</dt>
                  <dd>
                    {{
                      system.capabilities
                        .map((capability) => capability.kind)
                        .join(', ')
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Response</dt>
                  <dd>
                    {{
                      system.responseProfile.thermalLagMinutes
                        ? `${system.responseProfile.thermalLagMinutes} min lag`
                        : system.responseProfile.latencyMs
                          ? `${system.responseProfile.latencyMs}ms`
                          : 'learning'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd>
                    {{
                      system.policy.safeRange
                        ? `${system.policy.safeRange.min}-${system.policy.safeRange.max}${system.policy.safeRange.unit}`
                        : system.policy.notes || 'read-only'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>Signals</dt>
                  <dd>{{ system.learning.signals.slice(0, 3).join(', ') }}</dd>
                </div>
              </dl>
            </article>
          </div>
        </section>

</template>
