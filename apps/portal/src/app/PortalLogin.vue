<script setup lang="ts">
const email = defineModel<string>('email', { required: true });
const password = defineModel<string>('password', { required: true });
defineProps<{ theme: string; loginError: string }>();
const emit = defineEmits<{ login: [] }>();
</script>
<template>
  <main :class="['login-screen', `theme-${theme}`]">
    <section class="login-panel">
      <div class="brand-lockup large">
        <img class="brand-logo" src="/images/energrid-logo-symbol.png" alt="" />
        <div class="brand-copy">
          <h1>Energrid</h1>
          <span>Бъдещето е тук</span>
        </div>
      </div>
      <p class="login-lead">Smart automation command center</p>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" v-model="email" autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input
          id="password"
          v-model="password"
          autocomplete="current-password"
          type="password"
          @keydown.enter="emit('login')"
        />
      </div>
      <button class="primary wide" @click="emit('login')">Sign in</button>
      <p class="error">{{ loginError }}</p>
    </section>
  </main>

</template>
