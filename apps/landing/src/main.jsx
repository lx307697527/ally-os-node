import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/global.css'
import App from './App.jsx'
import { hashRouteToPath } from './lib/hashRouteMigration.js'

// [FEAT-586, issue #3873] Correct a legacy fragment address BEFORE the first
// render, so a visitor arriving at `/#/about` lands on `/about` having seen
// only the right page.
//
// This runs here rather than in an effect inside App for a reason you can see:
// an effect fires after the first paint, so the visitor would watch the wrong
// route render and then replace itself.
//
// It is a rewrite, not a redirect — `replaceState` changes the address without
// a round trip and without adding a history entry, so the back button still
// goes where the visitor came from rather than bouncing off this line.
//
// `null` means "nothing to migrate" and MUST be respected. Rewriting
// unconditionally would eat `#book`, the in-page anchor on /work-with-us, which
// is the very behaviour this change removes.
const migrated = hashRouteToPath(
  window.location.pathname,
  window.location.hash,
  window.location.search,
)
if (migrated !== null) window.history.replaceState(null, '', migrated)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
