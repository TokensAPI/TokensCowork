<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { isPlatform } from '../session'
import { ICONS, MY_ORGANIZATION, legacyHref, viewById } from '../views'
import AppIcon from '../components/AppIcon.vue'
import PageHeader from '../components/PageHeader.vue'

/** A page that has not moved here yet: its title, and the way to it in the console at /admin/. */
const route = useRoute()
const id = computed(() => String(route.meta.view || route.params.view || ''))
const view = computed(() => viewById(id.value))
const heading = computed(() => (!isPlatform.value && id.value === 'organizations' ? MY_ORGANIZATION : view.value ?? { title: '', description: '' }))
// The old console takes the whole address, a page's own route after the slash included.
const href = computed(() => legacyHref(route.fullPath.replace(/^\/+/u, '')))
</script>

<template>
  <PageHeader :title="heading.title" :description="heading.description" />
  <div class="page-body">
    <div class="container-fluid">
      <div class="card">
        <div class="empty">
          <p class="empty-title">「{{ heading.title }}」页还在旧后台</p>
          <p class="empty-subtitle text-secondary">新后台正在一页一页迁移；这一页迁好之前，请在旧后台使用，登录状态通用。</p>
          <div class="empty-action">
            <a class="btn btn-primary" :href="href"><AppIcon :paths="ICONS.external" />在旧后台打开</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
