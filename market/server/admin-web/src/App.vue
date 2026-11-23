<script setup lang="ts">
import { computed } from 'vue'
import AppSidebar from './components/AppSidebar.vue'
import AppHeader from './components/AppHeader.vue'
import LoginPanel from './components/LoginPanel.vue'
import ToastMessage from './components/ToastMessage.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { state } from './session'
import { formatTime, shell } from './shell'

/** The frame: sidebar and header around the open page once signed in, the sign-in page before. */
const signedIn = computed(() => !!state.session)
</script>

<template>
  <div class="page">
    <AppSidebar v-if="signedIn" />
    <div class="page-wrapper">
      <AppHeader />
      <ToastMessage />
      <LoginPanel v-if="!signedIn" />
      <main v-else>
        <RouterView />
      </main>
      <footer class="footer footer-transparent d-print-none">
        <div class="container-fluid d-flex flex-wrap gap-2 text-secondary">
          <span>TokensCowork / 插件市场 · 账号与组织来自 TokensAPI</span>
          <span v-if="signedIn && shell.lastRefresh" class="ms-auto">更新于 {{ formatTime(shell.lastRefresh) }}</span>
        </div>
      </footer>
    </div>
  </div>
  <ConfirmDialog />
</template>
