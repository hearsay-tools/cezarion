import net from 'node:net'

/**
 * Outbound network isolation for the server unit suite (hearsay-tools/cezarion#2367). A mutant
 * that turns an injected dependency into the real one (`io.discover ?? discoverCockpit` →
 * `&&`) made a CLI test POST its fixture to the live cockpit and start a real task. This guard
 * sits outside every mutated source: it refuses a TCP connection before transport (and before
 * DNS) unless the destination is a loopback server a test can own, and records the refusal so
 * the test fails even when the code under test swallowed the error.
 *
 * Allowed: a unix socket path; a loopback address and port that a server in this process listens
 * on (a wildcard bind covers the loopback addresses of the families it binds); a
 * loopback port below 1024 (nothing unprivileged listens there, and tests use :1 as a closed
 * port); a loopback port from 32768 up, where `listen(0)` lands, including the fixture servers
 * child processes start (the OpenCode mock). Refused: every other host, and loopback ports 1024
 * to 32767 — the cockpit range 4321–4370 and the usual dev-server ports.
 */

export interface OutboundRefusal { destination: string; stack: string }

interface GuardState { served: Map<string, number>; refusals: OutboundRefusal[] }

const STATE_KEY = Symbol.for('cezar.test-outbound-guard')
const REFUSED = 'ERR_TEST_OUTBOUND_REFUSED'
const LOWEST_EPHEMERAL_PORT = 32_768
const LOWEST_UNPRIVILEGED_PORT = 1024

/** One record per process: module isolation re-imports this file, but `net` is shared. */
function state(): GuardState {
  const global = globalThis as { [STATE_KEY]?: GuardState }
  global[STATE_KEY] ??= { served: new Map(), refusals: [] }
  return global[STATE_KEY]
}

/** Brackets and IPv4-mapped prefixes off, lower case: `[::FFFF:127.0.0.1]` is `127.0.0.1`. */
function bareHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase().replace(/^::ffff:(?=\d+\.)/, '')
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

const familyOf = (address: string): 4 | 6 => (address.includes(':') ? 6 : 4)

/**
 * One listener's records. A bind to one address covers that address; a wildcard covers every
 * loopback address of the families it binds: `0.0.0.0` IPv4 only, `::` IPv6 and, unless
 * `ipv6Only`, IPv4 too. Another process may hold the same port in a family left uncovered.
 */
export function servedKeys(address: string, port: number, ipv6Only = false): string[] {
  const bare = bareHost(address)
  if (bare === '0.0.0.0') return [`*4|${port}`]
  if (bare === '::') return ipv6Only ? [`*6|${port}`] : [`*4|${port}`, `*6|${port}`]
  return [`${bare}|${port}`]
}

/**
 * The loopback addresses a connection to `host` may reach. `localhost` may resolve to either
 * family, so it needs both; `0.0.0.0` and `::` connect to the local address of their family.
 */
function reachedAddresses(host: string): string[] {
  if (host === 'localhost') return ['127.0.0.1', '::1']
  if (host === '0.0.0.0') return ['127.0.0.1']
  if (host === '::') return ['::1']
  return [host]
}

/**
 * Whether this process owns `port` on every address the connection may reach: the address
 * itself, or a wildcard of its family. Whoever binds the rest may be a live cockpit
 * (hearsay-tools/cezarion#2367).
 */
function servesEvery(host: string, port: number, served: ReadonlySet<string> | ReadonlyMap<string, unknown>): boolean {
  return reachedAddresses(host).every(address => served.has(`${address}|${port}`) || served.has(`*${familyOf(address)}|${port}`))
}

/** The decision alone: `host` undefined is localhost, as `net` reads it. */
export function refusesConnection(host: string | undefined, port: number, served: ReadonlySet<string> | ReadonlyMap<string, unknown>): boolean {
  const bare = bareHost(host ?? 'localhost')
  if (!isLoopbackHost(bare)) return true
  if (servesEvery(bare, port, served)) return false
  return port >= LOWEST_UNPRIVILEGED_PORT && port < LOWEST_EPHEMERAL_PORT
}

/** `connect(options)`, `connect(port, host)`, `connect(path)`, or net's normalized `[options, cb]`. */
function destinationOf(args: unknown[]): { path: true } | { host: string | undefined; port: number } {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (first !== null && typeof first === 'object') {
    const options = first as { path?: unknown; host?: unknown; port?: unknown }
    if (options.path !== undefined) return { path: true }
    return { host: typeof options.host === 'string' ? options.host : undefined, port: Number(options.port) }
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: true }
  return { host: typeof args[1] === 'string' ? args[1] : undefined, port: Number(first) }
}

const message = (destinations: string[]): string =>
  `The test setup refused an outbound connection to ${destinations.join(', ')} (hearsay-tools/cezarion#2367). ` +
  'A test may reach only a loopback server it starts: an address and port this process listens on, a port below 1024, or a port from 32768 up. ' +
  'A real dependency ran in place of the injected one, or the test needs its own fixture server.'

/** Patches `net` once per process. Every `fetch`, `http`, `https` and `net` client connects through `Socket#connect`. */
export function installOutboundGuard(): void {
  const proto = net.Socket.prototype as net.Socket & { [STATE_KEY]?: true }
  if (proto[STATE_KEY]) return
  proto[STATE_KEY] = true
  const { served, refusals } = state()

  const connect = proto.connect as (...args: unknown[]) => net.Socket
  proto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = destinationOf(args)
    if ('path' in target || Number.isNaN(target.port) || !refusesConnection(target.host, target.port, served)) {
      return connect.apply(this, args)
    }
    const destination = `${target.host ?? 'localhost'}:${target.port}`
    const error = Object.assign(new Error(message([destination])), { code: REFUSED })
    refusals.push({ destination, stack: error.stack ?? '' })
    process.nextTick(() => this.destroy(error))
    return this
  } as typeof proto.connect

  const listen = net.Server.prototype.listen as (...args: unknown[]) => net.Server
  net.Server.prototype.listen = function trackedListen(this: net.Server, ...args: unknown[]): net.Server {
    this.once('listening', () => {
      const address = this.address()
      if (address === null || typeof address === 'string') return
      const options = args[0] as { ipv6Only?: unknown } | null | undefined
      const keys = servedKeys(address.address, address.port, typeof options === 'object' && options?.ipv6Only === true)
      for (const key of keys) served.set(key, (served.get(key) ?? 0) + 1)
      this.once('close', () => {
        for (const key of keys) {
          const left = (served.get(key) ?? 1) - 1
          if (left > 0) served.set(key, left)
          else served.delete(key)
        }
      })
    })
    return listen.apply(this, args)
  } as typeof net.Server.prototype.listen
}

/** The refusals recorded since the last call. */
export function takeOutboundRefusals(): OutboundRefusal[] {
  return state().refusals.splice(0)
}

/** Throws the refusals recorded since the last call: the test setup runs it after each test. */
export function throwOutboundRefusals(): void {
  const taken = takeOutboundRefusals()
  if (taken.length === 0) return
  const error = new Error(message([...new Set(taken.map(refusal => refusal.destination))]))
  error.stack = `${error.message}\nFirst refused at:\n${taken[0]?.stack ?? ''}`
  throw error
}
