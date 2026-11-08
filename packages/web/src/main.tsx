import { productName } from '@/lib/product-name'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setApiBaseUrl } from '@open-mercato/cezar-api-client/utils/project-scope'
import { resolveBuildApiBase } from './lib/build-env'
import { App } from './app'
import './styles/index.css'
import './styles/accessibility.css'

/**
 * Where the API lives, resolved before anything can fetch.
 *
 * Empty — same origin — is the bundled cockpit's case and the default: the service serves this
 * page and owns `/api/v1/*` under the same authority. The two overrides exist for the case this
 * whole split was for, a cockpit talking to a service somewhere else:
 *
 * - `VITE_CEZ_API_BASE` bakes it in at build time, for a bundle shipped separately.
 * - `<meta name="cez-api-base" content="…">` sets it at RUN time, so an operator can point a
 *   deployed bundle at a different service without rebuilding it. It wins, because the HTML is
 *   served per deployment while the bundle is baked once.
 */
const apiMeta = document.querySelector('meta[name="cez-api-base"]')?.getAttribute('content')
setApiBaseUrl(resolveBuildApiBase(apiMeta, import.meta.env.VITE_HSQ_API_BASE, import.meta.env.VITE_CEZ_API_BASE))

const container = document.getElementById('root')
if (!container) throw new Error(`${productName('cezar')}: #root container is missing from index.html`)

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
