import './test-git-env.mjs'
import { createTestSandbox } from './test-sandbox.mjs'
import { configureTestHome } from './test-home-setup.mjs'

// Only node:test entry points load this file. Browser workers keep their host
// home so the browser can find its installed runtime and credentials.
const sandbox = createTestSandbox('cez-node-test-home-')
configureTestHome({ userHome: sandbox })
