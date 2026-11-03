import { readFileSync, realpathSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const readManifest = path => JSON.parse(readFileSync(path, 'utf8'))

/** Refuse ancestor installs before a test can exercise another checkout. */
export function checkWorkspaceResolution(root = resolve(import.meta.dirname, '..')) {
  const fail = (detail) => {
    throw new Error(`Workspace dependencies must resolve inside ${root}: ${detail}; run \`pnpm install --frozen-lockfile\`.`)
  }
  const inside = (path) => {
    const offset = relative(realpathSync(root), realpathSync(path))
    if (offset === '..' || offset.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(offset)) fail(path)
  }
  try {
    inside(join(root, 'node_modules'))
    const rootManifestPath = join(root, 'package.json')
    const rootManifest = readManifest(rootManifestPath)
    const checkPackage = (name, consumer) => {
      // Resolve manifests without requiring built entry points or exported subpaths.
      const path = findPackageJSON(name, pathToFileURL(consumer))
      if (!path) fail(name)
      inside(dirname(path))
    }
    for (const name of Object.keys({ ...rootManifest.dependencies, ...rootManifest.devDependencies })) {
      checkPackage(name, rootManifestPath)
    }
    const workspaces = rootManifest.workspaces.map(directory => {
      const manifestPath = join(root, directory, 'package.json')
      return { manifestPath, manifest: readManifest(manifestPath) }
    })
    const names = new Set(workspaces.map(({ manifest }) => manifest.name))
    for (const { manifestPath, manifest } of workspaces) {
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }
      for (const name of Object.keys(dependencies).filter(name => names.has(name))) {
        checkPackage(name, manifestPath)
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('run `pnpm install --frozen-lockfile`')) throw error
    fail(error instanceof Error ? error.message : String(error))
  }
}
