import './test-git-env.mjs'
import { createTestSandbox } from './test-sandbox.mjs'
import { configureTestHome } from './test-home-setup.mjs'

// P0b exception: browser discovery needs host HOME. Cockpit/XDG state stays private.
configureTestHome({ userHome: createTestSandbox('cez-browser-test-home-'), keepHostHome: true })
