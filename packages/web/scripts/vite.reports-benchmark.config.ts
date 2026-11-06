/** Harness-only production profiling build; no product instrumentation. */
import { mergeConfig } from 'vite'
import base from '../vite.config'
export default mergeConfig(base, { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] } })
