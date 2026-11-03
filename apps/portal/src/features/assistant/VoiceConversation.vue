<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'home' | 'portal'; transcript: string; assistant: string }>(), { variant: 'portal' });
</script>
<template>
  <div v-if="variant === 'home'" class="home-assistant-conversation" aria-live="polite">
    <article><span>ТИ</span><p>{{ transcript || 'Тук ще се покаже разпознатата ти реч.' }}</p></article>
    <article><span>ENERGRID</span><p>{{ assistant || 'Отговорът ще се появи тук и ще бъде прочетен на глас.' }}</p></article>
  </div>
  <div v-else class="conversation" aria-live="polite">
    <div><span>Transcript</span><p>{{ transcript || 'Waiting for your command' }}</p></div>
    <div><span>Assistant</span><p>{{ assistant || 'Ready to translate intent into a safe plan' }}</p></div>
  </div>
</template>
