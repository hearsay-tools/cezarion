/** Windows PowerShell 5.1, the one PowerShell every supported Windows host has. */
export const POWERSHELL = 'powershell.exe';

/**
 * The environment for a Windows PowerShell 5.1 child. PowerShell 7 exports its own `PSModulePath`,
 * and a 5.1 child that inherits it finds PowerShell 7's built-in modules first, so autoloading
 * cmdlets such as `Set-Acl` or `Get-CimInstance` fails. Without the variable, 5.1 builds its
 * default module path. Windows environment names ignore case, so every spelling goes.
 */
export function powershellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
}
