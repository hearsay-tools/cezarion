import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'

interface Manifest { socket: string; spec?: string }

async function command(socket: string, action: string, spec: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection(socket)
    let result = ''
    // bound: a dead capture endpoint must fail within the existing 60-second hook budget.
    connection.setTimeout(10_000, () => connection.destroy(new Error('Node coverage endpoint did not answer')))
    connection.on('connect', () => connection.write(`${JSON.stringify({ action, spec })}\n`))
    connection.on('data', chunk => { result += chunk })
    connection.on('error', reject)
    connection.on('end', () => {
      try {
        const response = JSON.parse(result) as { ok?: boolean; error?: string }
        if (!response.ok) throw new Error(response.error ?? 'capture did not acknowledge the command')
        resolve()
      } catch (error) { reject(error) }
    })
  })
}

function server(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, 'control.json'), 'utf8')) as Manifest
}

async function servers(root: string, action: string, spec: string): Promise<void> {
  const shared = server(root)
  if (!existsSync(shared.socket)) throw new Error('the shared server capture socket is missing')
  await command(shared.socket, action, spec)
  const directory = join(root, 'servers')
  for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
    const manifest = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Manifest
    if (manifest.socket === shared.socket || !existsSync(manifest.socket)) continue
    try { await command(manifest.socket, action, spec) }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
}

export async function beginNodeCapture(root: string, spec: string): Promise<void> {
  await servers(root, 'begin', spec)
}

export async function endNodeCapture(root: string, spec: string): Promise<void> {
  await servers(root, 'end', spec)
  const directory = join(root, 'processes')
  for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
    const manifest = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Manifest
    if (!manifest.spec || !existsSync(manifest.socket)) continue
    try { await command(manifest.socket, 'flush', spec) }
    catch (error) {
      // A process can exit between the manifest read and connect; Node flushed on exit.
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
}
