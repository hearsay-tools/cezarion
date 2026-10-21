param([string]$Mode = 'probe', [string]$Root)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class LeaseJobProbe {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long PerProcess, PerJob; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved, desktop, title; public uint x,y,w,h,cx,cy,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref Extended info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup si, out ProcessInfo pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  public static IntPtr Open() {
    var job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw new Win32Exception();
    var info=new Extended(); info.Basic.Flags=0x2000|0x800; // KILL_ON_JOB_CLOSE | BREAKAWAY_OK
    if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf<Extended>())) { CloseHandle(job); throw new Win32Exception(); }
    return job;
  }
  public static uint Start(string command, IntPtr job, bool escape) {
    var si=new Startup(); si.cb=(uint)Marshal.SizeOf<Startup>(); ProcessInfo pi;
    if(!CreateProcess(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,4u|(escape?0x01000000u:0u),IntPtr.Zero,null,ref si,out pi)) throw new Win32Exception();
    try {
      if(job!=IntPtr.Zero && !AssignProcessToJobObject(job,pi.process)) throw new Win32Exception();
      if(ResumeThread(pi.thread)==0xffffffff) throw new Win32Exception();
      return pi.pid;
    } catch { TerminateProcess(pi.process,1); throw; }
    finally { CloseHandle(pi.thread); CloseHandle(pi.process); }
  }
}
'@
function Await-File([string]$Path) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (!(Test-Path $Path)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw "Timed out waiting for $Path" }
    Start-Sleep -Milliseconds 50
  }
}
if ($Mode -eq 'member') {
  $node = (Get-Command node).Source
  $child = [LeaseJobProbe]::Start('"' + $node + '" "' + $Root + '\child.cjs"', [IntPtr]::Zero, $false)
  $cached = [LeaseJobProbe]::Start('"' + $node + '" "' + $Root + '\cached.cjs"', [IntPtr]::Zero, $true)
  Set-Content "$Root\member.json" (@{child=$child;cached=$cached;member=$PID} | ConvertTo-Json -Compress)
  Start-Sleep -Seconds 120
  exit
}
$Root = Join-Path $env:RUNNER_TEMP ('lease-probe-' + [Guid]::NewGuid())
New-Item -ItemType Directory $Root | Out-Null
$job = [IntPtr]::Zero
$cachedPid = $null
try {
  Set-Content "$Root\child.cjs" 'setInterval(() => {}, 1000)'
  Set-Content "$Root\cached.cjs" 'setInterval(() => {}, 1000)'
  $job = [LeaseJobProbe]::Open()
  $pwsh = (Get-Process -Id $PID).Path
  $member = [LeaseJobProbe]::Start('"' + $pwsh + '" -NoProfile -File "' + $PSCommandPath + '" -Mode member -Root "' + $Root + '"', $job, $false)
  Await-File "$Root\member.json"
  $info = Get-Content "$Root\member.json" -Raw | ConvertFrom-Json
  $cachedPid = $info.cached
  if (!(Get-Process -Id $info.child -ErrorAction SilentlyContinue)) { throw 'Mutating child never started' }
  [LeaseJobProbe]::CloseHandle($job) | Out-Null
  $job = [IntPtr]::Zero
  Start-Sleep -Seconds 1
  if (Get-Process -Id $info.child -ErrorAction SilentlyContinue) { throw 'Job child survived handle close' }
  if (Get-Process -Id $member -ErrorAction SilentlyContinue) { throw 'Job leader survived handle close' }
  if (!(Get-Process -Id $cachedPid -ErrorAction SilentlyContinue)) { throw 'Cached app did not escape the job' }
  $bash = 'C:\Program Files\Git\bin\bash.exe'
  & $bash -c 'echo "shell=$$"; node -e "console.log(JSON.stringify({node:process.pid,parent:process.ppid}))"; ps -p $$'
  if ($LASTEXITCODE -ne 0) { throw 'Git Bash PID probe failed' }
  Write-Output 'PASS: job-close kills mutating children; explicit breakaway preserves cached app'
} finally {
  if ($job -ne [IntPtr]::Zero) { [LeaseJobProbe]::CloseHandle($job) | Out-Null }
  if ($cachedPid) { Stop-Process -Id $cachedPid -Force -ErrorAction SilentlyContinue }
  Remove-Item $Root -Recurse -Force
}
