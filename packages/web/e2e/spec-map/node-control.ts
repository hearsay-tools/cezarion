import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'

interface Manifest { socket: string; spec?: string; pid?: number; taskId?: string; coverageDirectory?: string }

async function command(socket: string, action: string, spec: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection(socket)
    let result = ''
    // bound: a dead capture endpoint must fail within the existing 60-second hook budget.
    connection.setTimeout(10_000, () => connection.destroy(new Error(`Node coverage endpoint did not answer: ${action} ${spec} at ${socket}`)))
    connection.on('connect', () => connection.write(`${JSON.stringify({ action, spec })}\n`))
    connection.on('data', chunk => { result += chunk })
    connection.on('error', error => {
      error.message += `: ${action} ${spec} at ${socket}`
      reject(error)
    })
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
    if (manifest.socket === shared.socket || manifest.spec !== spec || !existsSync(manifest.socket)) continue
    try { await command(manifest.socket, action, spec) }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
}

export async function beginNodeCapture(root: string, spec: string): Promise<void> {
  await servers(root, 'begin', spec)
}

function completed(manifest: Manifest): boolean {
  if (!manifest.coverageDirectory || !manifest.pid) return false
  const file = join(manifest.coverageDirectory, `completed-${manifest.pid}.json`)
  if (!existsSync(file)) return false
  const receipt = JSON.parse(readFileSync(file, 'utf8')) as Manifest
  return receipt.pid === manifest.pid && receipt.spec === manifest.spec && receipt.taskId === manifest.taskId
    && readdirSync(manifest.coverageDirectory).some(name => name.startsWith(`coverage-${manifest.pid}-`))
}

export async function endNodeCapture(root: string, spec: string): Promise<void> {
  await servers(root, 'end', spec)
  const directory = join(root, 'processes')
  for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
    const manifest = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Manifest
    if (!manifest.spec) continue
    if (!existsSync(manifest.socket)) {
      const hasCoverage = manifest.coverageDirectory && existsSync(manifest.coverageDirectory)
        && readdirSync(manifest.coverageDirectory).some(name => name.startsWith(`coverage-${manifest.pid}-`))
      if (!hasCoverage) {
        throw new Error(`Node coverage missing for terminated process ${manifest.pid} (${manifest.spec}) in ${manifest.coverageDirectory}`)
      }
      continue
    }
    try { await command(manifest.socket, 'flush', spec) }
    catch (error) {
      // A persisted final flush acknowledges capture even if exit closed IPC before its reply.
      if (completed(manifest)) continue
      // A process can exit between the manifest read and connect; Node flushed on exit.
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
}
