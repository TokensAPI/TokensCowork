import { createApp } from 'vue'
import App from './App.vue'
import { createConsoleRouter } from './router'
import { restore } from './session'
import { startTheme } from './theme'
import './styles/console.css'

startTheme()
const app = createApp(App)
app.use(createConsoleRouter())
app.mount('#app')
// Nobody signed in is the sign-in page, not an error.
restore().catch(() => {})
