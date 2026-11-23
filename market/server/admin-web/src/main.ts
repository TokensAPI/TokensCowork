import { createApp } from 'vue'
import App from './App.vue'
import { createConsoleRouter } from './router'
import { isPlatform, onSessionChange, restore } from './session'
import { loadCounts } from './counts'
import { shell } from './shell'
import { startTheme } from './theme'
import './styles/console.css'

startTheme()
// Signing in reads the sidebar's counts; signing out forgets them with the rest of the account.
onSessionChange((signedIn) => {
  shell.counts = {}
  shell.lastRefresh = 0
  if (signedIn && isPlatform.value) void loadCounts()
})
const app = createApp(App)
app.use(createConsoleRouter())
app.mount('#app')
// Nobody signed in is the sign-in page, not an error.
restore().catch(() => {})
