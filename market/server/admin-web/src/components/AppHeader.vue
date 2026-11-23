<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { environmentLabel, isPlatform, signOut, state } from '../session'
import { runAction } from '../feedback'
import { shell } from '../shell'
import { chooseTheme, themePreference } from '../theme'
import { ICONS } from '../views'

/**
 * The top bar: the environment, 刷新 and 退出登录 once signed in, and the theme.
 */
const pending = ref<'' | 'refresh' | 'logout'>('')
const environmentTitle = computed(() => (isPlatform.value ? state.session?.environment?.origin || '尚未配置 TokensAPI 地址' : environmentLabel.value))

async function refresh() {
  if (pending.value || !shell.refresh) return
  pending.value = 'refresh'
  await runAction(shell.refresh, { success: '已刷新。' })
  pending.value = ''
}
async function logout() {
  if (pending.value) return
  pending.value = 'logout'
  await runAction(signOut, { success: '已安全退出登录。' })
  pending.value = ''
}
</script>

<template>
  <header class="navbar navbar-expand d-print-none">
    <div class="container-fluid">
      <div class="navbar-nav flex-row align-items-center gap-2 ms-auto">
        <div v-if="state.session" class="d-flex align-items-center gap-2">
          <span class="badge bg-green-lt text-truncate environment-badge" :title="environmentTitle">{{ environmentLabel }}</span>
          <button :class="['btn', pending === 'refresh' && 'btn-loading']" type="button" aria-label="刷新" :disabled="!!pending || !shell.refresh" @click="refresh">
            <AppIcon :paths="ICONS.refresh" /><span class="d-none d-sm-inline">刷新</span>
          </button>
          <button :class="['btn', 'btn-ghost-secondary', pending === 'logout' && 'btn-loading']" type="button" aria-label="退出登录" :disabled="!!pending" @click="logout">
            <AppIcon :paths="ICONS.logout" /><span class="d-none d-sm-inline">退出登录</span>
          </button>
        </div>
        <select class="form-select w-auto" aria-label="主题外观" :value="themePreference" @change="chooseTheme(($event.target as HTMLSelectElement).value)">
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
    </div>
  </header>
</template>
