param([string]$Mode, [string]$Payload)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'identity') {
  $target = Get-Process -Id ([int]$Payload) -ErrorAction SilentlyContinue
  if ($target) { [string]$target.StartTime.ToUniversalTime().Ticks } else { 'gone' }
  exit
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class LeaseWindows {
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
  public static IntPtr Open(string name) {
    var job=CreateJobObject(IntPtr.Zero,name);
    if(job==IntPtr.Zero) throw new Win32Exception();
    var info=new Extended(); info.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; mutators must never break away
    if(!SetInformationJobObject(job,9,ref info,(uint)Marshal.SizeOf<Extended>())) { CloseHandle(job); throw new Win32Exception(); }
    return job;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr data, uint size, IntPtr length);
  public static string Live(string name) {
    var job=OpenJobObject(4,false,name);
    if(job==IntPtr.Zero) return Marshal.GetLastWin32Error()==2 ? "false" : "unknown";
    var data=Marshal.AllocHGlobal(48);
    try { if(!QueryInformationJobObject(job,1,data,48,IntPtr.Zero)) return "unknown"; return Marshal.ReadInt32(data,40)>0 ? "true" : "false"; }
    finally { Marshal.FreeHGlobal(data); CloseHandle(job); }
  }
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  public static uint Start(string command, IntPtr job) {
    var si=new Startup(); si.cb=(uint)Marshal.SizeOf<Startup>(); si.flags=0x100; si.input=GetStdHandle(-10); si.output=GetStdHandle(-11); si.error=GetStdHandle(-12); ProcessInfo pi;
    if(!CreateProcess(null,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,4u,IntPtr.Zero,null,ref si,out pi)) throw new Win32Exception();
    try {
      if(job!=IntPtr.Zero && !AssignProcessToJobObject(job,pi.process)) throw new Win32Exception();
      if(ResumeThread(pi.thread)==0xffffffff) throw new Win32Exception();
      return pi.pid;
    } catch { TerminateProcess(pi.process,1); throw; }
    finally { CloseHandle(pi.thread); CloseHandle(pi.process); }
  }
}
'@

if ($Mode -eq 'live') { [LeaseWindows]::Live($Payload); exit }
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
if ($Mode -ne 'run') { throw 'Unknown Windows lease mode' }
$job = [LeaseWindows]::Open($inputData.job)
try {
  # Create the named job before checking the supervisor. Recovery either sees
  # this job, or a dead supervisor whose command can no longer start.
  $parent = Get-Process -Id $inputData.parent -ErrorAction SilentlyContinue
  if (!$parent) { throw 'Lease supervisor exited before command launch' }
  [void]$parent.Handle
  if ([string]$parent.StartTime.ToUniversalTime().Ticks -ne $inputData.start) { throw 'Lease supervisor identity changed' }
  if ($parent.HasExited) { throw 'Lease supervisor exited before command launch' }
  $childPid = [LeaseWindows]::Start($inputData.command, $job)
  $child = Get-Process -Id $childPid -ErrorAction SilentlyContinue
  if (!$child) { exit 1 }
  while (!$child.WaitForExit(100)) {
    if ($parent.HasExited) { [Console]::Error.WriteLine('Test environment supervisor exited; closing Windows job'); exit 143 }
  }
  exit $child.ExitCode
} finally {
  [LeaseWindows]::CloseHandle($job) | Out-Null
  [Console]::Error.WriteLine('Test environment Windows job handle closed')
}
