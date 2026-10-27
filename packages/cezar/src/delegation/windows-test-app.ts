import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

// The server receives an absolute --repo even though its script path is relative. Parse
// the native command line into argv; substring matching would admit another checkout.
const argvReader = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CezArgv {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string text, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
  public static string[] Parse(string text) {
    int count; var ptr=CommandLineToArgvW(text, out count);
    if (ptr == IntPtr.Zero) throw new Exception("CommandLineToArgvW failed");
    try { var result=new string[count]; for (int i=0; i<count; i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(ptr, i*IntPtr.Size)); return result; }
    finally { LocalFree(ptr); }
  }
}
'@
`;

function powershell(script: string): string | undefined {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Matches test-env-lease.mjs's Windows start identity. */
export function windowsStartToken(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const value = powershell(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [string]$p.StartTime.ToUniversalTime().Ticks }`);
  return value && /^\d+$/.test(value) ? value : undefined;
}

/** Only the worker's checkout or the isolated clone created inside it is its served repo. */
export function windowsTestAppOwned(args: readonly string[], root: string): boolean {
  const normalize = (path: string) => win32.resolve(path).toLowerCase();
  if (!/^(?:node|node\.exe)$/i.test(win32.basename(args[0] ?? '')) || !args[1]) return false;
  if (normalize(win32.resolve(root, args[1])) !== normalize(win32.join(root, '.ai', 'qa', 'build', 'cezar', 'dist', 'index.js'))) return false;
  const positions = args.flatMap((arg, index) => arg === '--repo' ? [index] : []);
  if (positions.length !== 1) return false;
  const repo = args[positions[0]! + 1];
  if (!repo || !win32.isAbsolute(repo)) return false;
  return [root, win32.join(root, '.ai', 'qa', 'served', win32.basename(root))].some(path => normalize(path) === normalize(repo));
}

export function windowsTestAppHolds(pid: number, start: string, root: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const text = powershell(`${argvReader}
$p=Get-Process -Id ${pid} -ErrorAction Stop
$c=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop
@{ start=[string]$p.StartTime.ToUniversalTime().Ticks; args=@([CezArgv]::Parse($c.CommandLine)) } | ConvertTo-Json -Compress`);
  try {
    const result = JSON.parse(text ?? 'null');
    return result?.start === start && Array.isArray(result.args) && result.args.every((arg: unknown) => typeof arg === 'string') && windowsTestAppOwned(result.args, root);
  } catch { return false; }
}
