<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppIcon from './AppIcon.vue'
import { allowedViews, isPlatform } from '../session'
import { shell } from '../shell'
import { ICONS, VIEWS, legacyHref } from '../views'

/**
 * The sidebar, as at /admin/: the pages this account may open, then the API reference. A page
 * drawn here is a router link; one still in the old console links there (marked ↗). On a narrow
 * screen it is a collapsed menu; picking a page closes it.
 */
const route = useRoute()
const expanded = ref(false)
watch(() => route.fullPath, () => (expanded.value = false))

const entries = computed(() =>
  VIEWS.filter((view) => allowedViews.value.includes(view.id)).map((view) => ({
    ...view,
    title: view.id === 'organizations' && !isPlatform.value ? '我的组织' : view.title,
    // An organization administrator has exactly one organization; a count means nothing there.
    count: view.id === 'organizations' && !isPlatform.value ? undefined : shell.counts[view.id],
    active: String(route.meta.view || route.params.view || '') === view.id,
  })),
)
</script>

<template>
  <aside class="navbar navbar-vertical navbar-expand-lg" data-bs-theme="dark">
    <div class="container-fluid">
      <button class="navbar-toggler" type="button" aria-controls="sidebar-menu" :aria-expanded="expanded ? 'true' : 'false'" aria-label="打开导航" @click="expanded = !expanded">
        <span class="navbar-toggler-icon"></span>
      </button>
      <RouterLink class="navbar-brand" to="/"><img src="/admin/assets/logo-mark.svg" alt="" class="navbar-brand-image" /><span class="brand-name">TokensCowork</span></RouterLink>
      <div id="sidebar-menu" :class="['collapse', 'navbar-collapse', expanded && 'show']">
        <ul class="navbar-nav pt-lg-3" aria-label="后台导航">
          <li v-for="entry in entries" :key="entry.id" class="nav-item">
            <RouterLink v-if="entry.migrated" :to="{ name: entry.id }" :class="['nav-link', entry.active && 'active']" :aria-current="entry.active ? 'page' : undefined">
              <span class="nav-link-icon"><AppIcon :paths="entry.icon" /></span>
              <span class="nav-link-title">{{ entry.title }}</span>
              <span v-if="entry.count !== undefined" class="badge badge-sm ms-auto">{{ entry.count }}</span>
            </RouterLink>
            <a v-else class="nav-link" :href="legacyHref(entry.id)" :title="`「${entry.title}」页还在旧后台，点击前往`">
              <span class="nav-link-icon"><AppIcon :paths="entry.icon" /></span>
              <span class="nav-link-title">{{ entry.title }}</span>
              <span class="ms-auto legacy-mark" aria-label="旧后台"><AppIcon :paths="ICONS.external" /></span>
            </a>
          </li>
        </ul>
        <ul class="navbar-nav mt-lg-auto pb-lg-3">
          <li class="nav-item">
            <a class="nav-link" href="/admin/api-docs.html">
              <span class="nav-link-icon"><AppIcon :paths="ICONS.api" /></span>
              <span class="nav-link-title">API 文档</span>
            </a>
          </li>
        </ul>
      </div>
    </div>
  </aside>
</template>
