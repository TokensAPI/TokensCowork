<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { notify, runAction } from '../feedback'
import { signInWithPassphrase, signInWithTokensApi, state } from '../session'

/**
 * Sign-in, as at /admin/: by default with a TokensAPI organization administrator's account (the
 * access token from its TokensAPI settings plus the account id TokensAPI requires beside it; the
 * market asks TokensAPI who that is and never stores the token), or with the back-office
 * passphrase. The secret field is emptied as soon as it is sent.
 */
const platform = ref(false)
const pending = ref(false)
const passphrase = ref('')
const userId = ref('')
const accessToken = ref('')
const passphraseInput = ref<HTMLInputElement>()
const userInput = ref<HTMLInputElement>()

async function submit(fn: () => Promise<unknown>) {
  if (pending.value) return
  pending.value = true
  await runAction(fn)
  pending.value = false
}
function signInPlatform() {
  const credential = passphrase.value.trim()
  passphrase.value = ''
  void submit(() => signInWithPassphrase(credential))
}
function signInTenant() {
  const id = Number(userId.value.trim())
  const token = accessToken.value.trim()
  accessToken.value = ''
  void submit(() => signInWithTokensApi(id, token))
}
async function switchMode() {
  if (pending.value) return
  platform.value = !platform.value
  notify()
  await nextTick()
  ;(platform.value ? passphraseInput : userInput).value?.focus()
}
</script>

<template>
  <div class="page-body">
    <div class="container container-tight py-4">
      <div class="text-center mb-4">
        <span class="navbar-brand"><img src="/admin/assets/logo-mark.svg" alt="" class="navbar-brand-image" /><span class="brand-name">TokensCowork</span></span>
      </div>
      <div class="card card-md">
        <div class="card-body">
          <h1 class="h2 text-center mb-2">插件市场管理后台</h1>
          <p class="text-secondary text-center mb-4">登录后管理插件、组织与访问权限。</p>
          <p v-if="state.pending" class="text-secondary text-center">正在恢复登录状态…</p>
          <template v-else>
            <form v-if="!platform" :aria-busy="pending || undefined" @submit.prevent="signInTenant">
              <p class="text-secondary">
                用你在 TokensAPI 的账号登录：访问令牌在「个人设置 → 系统访问令牌」生成，用户 ID 在同一页。只有组织管理员可以登录，且只能配置自己的组织。
              </p>
              <div class="mb-3">
                <label class="form-label" for="tokensapi-user">TokensAPI 用户 ID</label>
                <input id="tokensapi-user" ref="userInput" v-model="userId" class="form-control" type="text" inputmode="numeric" pattern="[0-9]+" autocomplete="username" maxlength="12" required placeholder="例如 10086" />
              </div>
              <div class="mb-3">
                <label class="form-label" for="tokensapi-token">TokensAPI 访问令牌</label>
                <input id="tokensapi-token" v-model="accessToken" class="form-control" type="password" autocomplete="off" maxlength="4096" required placeholder="个人设置 → 系统访问令牌" />
              </div>
              <div class="form-footer"><button :class="['btn', 'btn-primary', 'w-100', pending && 'btn-loading']" type="submit" :disabled="pending">登录 TokensAPI 账号</button></div>
            </form>
            <form v-else :aria-busy="pending || undefined" @submit.prevent="signInPlatform">
              <div class="mb-3">
                <label class="form-label" for="admin-token">后台口令</label>
                <input id="admin-token" ref="passphraseInput" v-model="passphrase" class="form-control" type="password" autocomplete="current-password" maxlength="512" required placeholder="输入后台口令" />
              </div>
              <div class="form-footer"><button :class="['btn', 'btn-primary', 'w-100', pending && 'btn-loading']" type="submit" :disabled="pending">登录管理后台</button></div>
            </form>
          </template>
        </div>
        <div v-if="!state.pending" class="card-body pt-0">
          <button class="btn w-100" type="button" :disabled="pending" @click="switchMode">{{ platform ? '改用 TokensAPI 账号登录' : '改用后台口令登录' }}</button>
        </div>
      </div>
      <p class="text-center text-secondary mt-3">登录保持 7 天 · 凭证不保存在本地存储 · 账号与组织由 TokensAPI 管理</p>
    </div>
  </div>
</template>
