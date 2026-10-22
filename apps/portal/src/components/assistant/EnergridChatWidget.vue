<script setup lang="ts">
import { nextTick, ref } from 'vue';

const props = defineProps<{
  apiBase: string;
  accessToken: string;
}>();

type Message = {
  role: 'user' | 'assistant';
  text: string;
};

const open = ref(false);
const expanded = ref(false);
const messages = ref<Message[]>([]);
const draft = ref('');
const busy = ref(false);
const error = ref('');
const conversationId = ref('');
const conversation = ref<HTMLElement | null>(null);

async function send() {
  const text = draft.value.trim();
  if (!text || busy.value || !props.accessToken) return;

  draft.value = '';
  error.value = '';
  messages.value.push({ role: 'user', text });
  busy.value = true;

  await scrollToBottom();

  try {
    const response = await fetch(`${props.apiBase}/portal/assistant/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${props.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: text }),
    });

    if (!response.ok) {
      throw new Error(`Energrid request failed (${response.status})`);
    }

    const result = await response.json() as {
      reply: string;
      conversationId: string;
    };

    conversationId.value = result.conversationId;
    messages.value.push({
      role: 'assistant',
      text: result.reply || 'I received your message but could not produce a reply.',
    });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to reach Energrid';
    // Preserve the unsent message so it can be retried.
    draft.value = text;
    messages.value.pop();
  } finally {
    busy.value = false;
    await scrollToBottom();
  }
}

async function scrollToBottom() {
  await nextTick();
  conversation.value?.scrollTo({
    top: conversation.value.scrollHeight,
    behavior: 'smooth',
  });
}
</script>

<template>
  <div class="energrid-chat">
    <button
      v-if="!open"
      class="energrid-chat-launcher"
      type="button"
      aria-label="Open Energrid assistant"
      @click="open = true"
    >
      <img class="energrid-chat-logo" src="/images/energrid-logo-symbol.png" alt="" />
      Ask Energrid
    </button>

    <section
      v-else
      :class="['energrid-chat-panel', { 'is-expanded': expanded }]"
      aria-label="Conversation with Energrid"
    >
      <header class="energrid-chat-header">
        <div class="energrid-chat-brand">
          <img src="/images/energrid-logo-symbol.png" alt="" />
          <div>
            <strong>Energrid</strong>
            <small>Your home intelligence</small>
          </div>
        </div>
        <div class="energrid-chat-window-actions">
          <button
            type="button"
            :aria-label="expanded ? 'Restore chat size' : 'Expand chat'"
            @click="expanded = !expanded"
          >{{ expanded ? '↙' : '⛶' }}</button>
          <button
            type="button"
            aria-label="Minimize Energrid"
            @click="open = false"
          >×</button>
        </div>
      </header>

      <div ref="conversation" class="energrid-chat-messages" aria-live="polite">
        <div v-if="!messages.length" class="energrid-chat-welcome">
          <strong>Talk to your home.</strong>
          <p>Ask anything, explain something about your home, or just have a conversation.</p>
          <p class="energrid-chat-caveat">
            Live sensors and network tools are not connected to this chat yet.
          </p>
        </div>

        <article
          v-for="(message, index) in messages"
          :key="index"
          :class="['energrid-chat-message', message.role]"
        >
          <small>{{ message.role === 'user' ? 'You' : 'Energrid' }}</small>
          <p>{{ message.text }}</p>
        </article>

        <p v-if="busy" class="energrid-chat-working">Energrid is thinking…</p>
      </div>

      <p v-if="error" class="energrid-chat-error" role="alert">{{ error }}</p>

      <form class="energrid-chat-compose" @submit.prevent="send">
        <label class="energrid-chat-sr-only" for="energrid-chat-message">
          Message Energrid
        </label>
        <textarea
          id="energrid-chat-message"
          v-model="draft"
          rows="2"
          maxlength="4000"
          placeholder="Ask Energrid anything…"
          :disabled="busy"
          @keydown.enter.exact.prevent="send"
        />
        <button
          type="submit"
          :disabled="busy || !draft.trim()"
          aria-label="Send message"
        >➤</button>
      </form>
      <small class="energrid-chat-footer">
        Energrid Intelligence · Powered by Letta
      </small>
    </section>
  </div>
</template>

<style scoped>
.energrid-chat {
  position: fixed;
  right: 22px;
  bottom: 20px;
  z-index: 1100;
  font-family: inherit;
}
.energrid-chat-launcher {
  padding: 13px 20px;
  background: #2259b8;
  color: #fff;
  border: none;
  border-radius: 28px;
  font: inherit;
  font-weight: 650;
  box-shadow: 0 6px 28px #0004;
  cursor: pointer;
}
.energrid-chat-symbol { margin-right: 7px; }
.energrid-chat-panel {
  width: min(390px, calc(100vw - 24px));
  height: min(590px, calc(100dvh - 40px));
  background: #181e29;
  color: #f2f4f8;
  border: 1px solid #ffffff24;
  border-radius: 16px;
  box-shadow: 0 12px 48px #0008;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.energrid-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 17px;
  border-bottom: 1px solid #ffffff20;
}
.energrid-chat-header small {
  display: block;
  margin-top: 4px;
  opacity: .65;
}
.energrid-chat-header button {
  background: transparent;
  color: inherit;
  border: 0;
  font-size: 25px;
  cursor: pointer;
}
.energrid-chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.energrid-chat-welcome { padding: 10px 3px; }
.energrid-chat-caveat { font-size: 12px; opacity: .65; }
.energrid-chat-message {
  max-width: 88%;
  padding: 12px 14px;
  border-radius: 13px;
  background: #ffffff12;
  align-self: flex-start;
  overflow-wrap: anywhere;
}
.energrid-chat-message.user {
  background: #2259b8;
  align-self: flex-end;
}
.energrid-chat-message small { opacity: .7; }
.energrid-chat-message p {
  margin: 6px 0 0;
  white-space: pre-wrap;
  line-height: 1.5;
}
.energrid-chat-working { opacity: .65; }
.energrid-chat-error {
  color: #ffb5ad;
  font-size: 12px;
  padding: 0 16px;
}
.energrid-chat-compose {
  display: flex;
  gap: 9px;
  padding: 12px;
  border-top: 1px solid #ffffff20;
}
.energrid-chat-compose textarea {
  flex: 1;
  min-width: 0;
  resize: none;
  border: 1px solid #ffffff30;
  border-radius: 10px;
  background: #ffffff0a;
  color: inherit;
  padding: 10px;
  font: inherit;
}
.energrid-chat-compose button {
  align-self: end;
  border: 0;
  border-radius: 10px;
  padding: 12px;
  color: #fff;
  background: #2259b8;
  cursor: pointer;
}
.energrid-chat-compose button:disabled { opacity: .4; }
.energrid-chat-footer {
  padding: 0 14px 10px;
  opacity: .55;
  font-size: 10px;
}
.energrid-chat-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
@media (max-width: 640px) {
  .energrid-chat { right: 12px; bottom: 12px; }
  .energrid-chat-panel { height: min(640px, calc(100dvh - 24px)); }
}

/* Energrid assistant visual identity */
.energrid-chat {
  z-index: 9999;
}
.energrid-chat-launcher {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 18px 9px 9px;
  border-radius: 40px;
  background: linear-gradient(135deg, #182d49, #2357a2);
  border: 1px solid #ffffff30;
  box-shadow: 0 10px 35px #0005;
  transition: transform .18s ease, box-shadow .18s ease;
}
.energrid-chat-launcher:hover {
  transform: translateY(-3px);
  box-shadow: 0 14px 40px #0006;
}
.energrid-chat-logo {
  width: 40px;
  height: 40px;
  object-fit: contain;
  border-radius: 50%;
  padding: 6px;
  box-sizing: border-box;
  background: #ffffff19;
}
.energrid-chat-panel {
  width: min(440px, calc(100vw - 24px));
  height: min(650px, calc(100dvh - 36px));
  background: linear-gradient(160deg, #19273c, #131b28 55%);
  border: 1px solid #ffffff26;
  border-radius: 19px;
  box-shadow: 0 18px 70px #0009;
}
.energrid-chat-panel.is-expanded {
  width: min(850px, calc(100vw - 24px));
  height: min(850px, calc(100dvh - 36px));
}
.energrid-chat-header {
  padding: 18px;
  background: #ffffff07;
}
.energrid-chat-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.energrid-chat-brand img {
  width: 43px;
  height: 43px;
  object-fit: contain;
  padding: 7px;
  box-sizing: border-box;
  border-radius: 13px;
  background: #ffffff13;
}
.energrid-chat-brand strong {
  font-size: 17px;
  letter-spacing: -.2px;
}
.energrid-chat-window-actions {
  display: flex;
  gap: 9px;
}
.energrid-chat-window-actions button {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  font-size: 21px;
}
.energrid-chat-window-actions button:hover {
  background: #ffffff16;
}
.energrid-chat-messages {
  padding: 20px;
  gap: 16px;
}
.energrid-chat-message {
  border: 1px solid #ffffff0d;
  line-height: 1.55;
  border-radius: 15px 15px 15px 5px;
}
.energrid-chat-message.user {
  border-radius: 15px 15px 5px 15px;
  background: #285eb6;
}
.energrid-chat-welcome {
  margin: auto 0;
  text-align: center;
  line-height: 1.6;
}
.energrid-chat-welcome strong {
  font-size: 21px;
}
.energrid-chat-compose {
  padding: 14px 16px;
  background: #ffffff06;
}
.energrid-chat-compose textarea {
  border-radius: 13px;
  background: #ffffff0d;
  line-height: 1.5;
}
.energrid-chat-compose textarea:focus {
  outline: 2px solid #6498e8;
  outline-offset: 1px;
}
.energrid-chat-compose button {
  border-radius: 12px;
  min-width: 43px;
}
@media (max-width: 640px) {
  .energrid-chat-panel,
  .energrid-chat-panel.is-expanded {
    width: calc(100vw - 24px);
    height: min(720px, calc(100dvh - 24px));
  }
}


/* Energrid compact desktop density */
.energrid-chat-panel {
  width: min(430px, calc(100vw - 24px));
  height: min(630px, calc(100dvh - 36px));
  border-radius: 15px;
  font-size: 13px;
}

.energrid-chat-panel.is-expanded {
  width: min(820px, calc(100vw - 24px));
  height: min(800px, calc(100dvh - 36px));
}

.energrid-chat-header {
  padding: 11px 14px;
}

.energrid-chat-brand {
  gap: 9px;
}

.energrid-chat-brand img {
  width: 34px;
  height: 34px;
  padding: 5px;
  border-radius: 9px;
}

.energrid-chat-brand strong {
  font-size: 14px;
  font-weight: 650;
}

.energrid-chat-brand small {
  font-size: 10px;
  margin-top: 2px;
}

.energrid-chat-window-actions {
  gap: 4px;
}

.energrid-chat-window-actions button {
  width: 27px;
  height: 27px;
  font-size: 17px;
}

.energrid-chat-messages {
  padding: 14px;
  gap: 11px;
}

.energrid-chat-message {
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.5;
  border-radius: 11px 11px 11px 4px;
}

.energrid-chat-message.user {
  border-radius: 11px 11px 4px 11px;
}

.energrid-chat-message small {
  font-size: 10px;
}

.energrid-chat-message p {
  margin-top: 4px;
}

.energrid-chat-welcome strong {
  font-size: 17px;
}

.energrid-chat-welcome p {
  font-size: 12px;
}

.energrid-chat-compose {
  padding: 10px 12px;
  gap: 7px;
}

.energrid-chat-compose textarea {
  padding: 9px 11px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.4;
}

.energrid-chat-compose button {
  min-width: 36px;
  padding: 9px;
  border-radius: 9px;
}

.energrid-chat-footer {
  padding: 0 12px 8px;
  font-size: 9px;
}

.energrid-chat-launcher {
  padding: 7px 14px 7px 7px;
  gap: 8px;
  font-size: 12px;
}

.energrid-chat-logo {
  width: 34px;
  height: 34px;
  padding: 5px;
}

@media (max-width: 640px) {
  .energrid-chat-panel,
  .energrid-chat-panel.is-expanded {
    width: calc(100vw - 24px);
    height: min(720px, calc(100dvh - 24px));
  }
}

</style>
