// Windows counterpart of workspace.ts's private, no-follow identity file operations.
// Loaded by the adjacent PowerShell entry point; shipped with the CLI.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class CezWorkspaceIdentity {
  const uint ReadControl = 0x20000, ReadAttributes = 0x80, GenericRead = 0x80000000, GenericWrite = 0x40000000, Delete = 0x10000;
  const uint OpenReparse = 0x200000, BackupSemantics = 0x2000000, ReparsePoint = 0x400, DirectoryAttribute = 0x10;
  const uint ShareRead = 1, ShareWrite = 2, ShareDelete = 4, OpenExisting = 3, CreateNew = 1;
  const int FullControl = 0x1f01ff;
  static readonly string User = WindowsIdentity.GetCurrent().User.Value;
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential)] struct FileInformation {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct RenameInformation {
    public uint Replace; public IntPtr Root; public uint Length; public char Name;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateDirectoryW(string path, ref SecurityAttributes security);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityInfo(SafeFileHandle file, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr information, uint size);

  sealed class PrivateSecurity : IDisposable {
    GCHandle pinned; IntPtr attributes;
    public SecurityAttributes Value;
    public PrivateSecurity(bool directory) {
      string inheritance = directory ? "OICI" : "";
      var descriptor = new RawSecurityDescriptor("O:" + User + "D:P(A;" + inheritance + ";FA;;;" + User + ")(A;" + inheritance + ";FA;;;SY)(A;" + inheritance + ";FA;;;BA)");
      byte[] bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0);
      pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
      Value = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject() };
      attributes = Marshal.AllocHGlobal(Value.Length); Marshal.StructureToPtr(Value, attributes, false);
    }
    public IntPtr Pointer { get { return attributes; } }
    public void Dispose() { Marshal.FreeHGlobal(attributes); pinned.Free(); }
  }

  static string Canonical(string path) {
    // Device paths, streams and UNC shares are outside this local receipt store.
    if (path.Length < 3 || !Char.IsLetter(path[0]) || path[1] != ':' || (path[2] != '\\' && path[2] != '/'))
      throw new IOException("Identity path must be on a local drive");
    if (path.Substring(2).IndexOf(':') >= 0) throw new IOException("Identity path contains a stream");
    string full = Path.GetFullPath(path);
    return full.Length > 3 ? full.TrimEnd('\\') : full;
  }
  static SafeFileHandle Open(string path, uint access, uint share, bool missingAllowed) {
    var file = CreateFileW(path, access, share, IntPtr.Zero, OpenExisting, OpenReparse | BackupSemantics, IntPtr.Zero);
    if (!file.IsInvalid) return file;
    int error = Marshal.GetLastWin32Error(); file.Dispose();
    if (missingAllowed && (error == 2 || error == 3)) return null;
    throw new Win32Exception(error, "Cannot open workspace identity: " + path);
  }
  static FileInformation CheckObject(SafeFileHandle file, string path, bool directory) {
    FileInformation info;
    if (!GetFileInformationByHandle(file, out info)) throw new Win32Exception();
    if ((info.Attributes & ReparsePoint) != 0 || ((info.Attributes & DirectoryAttribute) != 0) != directory)
      throw new IOException("Redirected or wrong-kind workspace identity");
    if (!directory && info.Links != 1) throw new IOException("Linked workspace identity");
    var final = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(file, final, (uint)final.Capacity, 0);
    if (length == 0 || length >= final.Capacity) throw new IOException("Cannot resolve workspace identity handle");
    string name = final.ToString(); if (name.StartsWith("\\\\?\\")) name = name.Substring(4);
    if (!String.Equals(Canonical(name), path, StringComparison.OrdinalIgnoreCase)) throw new IOException("Workspace identity handle names another path");
    return info;
  }
  static void CheckPrivate(SafeFileHandle file) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error = GetSecurityInfo(file, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0) throw new Win32Exception((int)error);
    try {
      byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      var security = new RawSecurityDescriptor(bytes, 0);
      if (security.Owner == null || security.Owner.Value != User || security.DiscretionaryAcl == null ||
          (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0) throw new IOException("Unprotected workspace identity");
      bool userFullControl = false;
      foreach (GenericAce entry in security.DiscretionaryAcl) {
        var ace = entry as CommonAce;
        if (ace == null || ace.IsCallback || ace.AceQualifier != AceQualifier.AccessAllowed) throw new IOException("Unknown workspace identity ACL");
        string sid = ace.SecurityIdentifier.Value;
        if (sid != User && sid != "S-1-5-18" && sid != "S-1-5-32-544") throw new IOException("Broad workspace identity ACL");
        if (sid == User && (ace.AceFlags & AceFlags.InheritOnly) == 0 && (ace.AccessMask & FullControl) == FullControl) userFullControl = true;
      }
      if (!userFullControl) throw new IOException("Workspace identity owner lacks control");
    } finally { LocalFree(descriptor); }
  }

  // Pin every ancestor without FILE_SHARE_DELETE. Opening each component with
  // OPEN_REPARSE_POINT rejects junctions too, including intermediate components.
  sealed class Parents : IDisposable {
    readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
    public Parents(string path) {
      try {
        string directory = Path.GetDirectoryName(path), current = Path.GetPathRoot(path);
        Pin(current);
        foreach (string part in directory.Substring(current.Length).Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries)) {
          current = Path.Combine(current, part); Pin(current);
        }
      } catch { Dispose(); throw; }
    }
    void Pin(string path) {
      var file = Open(path, ReadAttributes, ShareRead | ShareWrite, false);
      handles.Add(file); CheckObject(file, Canonical(path), true);
    }
    public void Dispose() { for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose(); }
  }
  static SafeFileHandle PrivateFile(string path, bool missingAllowed, uint share) {
    var file = Open(path, GenericRead | ReadControl, share, missingAllowed);
    if (file == null) return null;
    try { CheckObject(file, path, false); CheckPrivate(file); return file; }
    catch { file.Dispose(); throw; }
  }
  static void PrivateDirectory(string path) {
    using (var file = Open(path, ReadAttributes | ReadControl, ShareRead | ShareWrite, false)) {
      CheckObject(file, path, true); CheckPrivate(file);
    }
  }
  public static void Directory(string input, bool create) {
    string path = Canonical(input);
    using (var parents = new Parents(path)) {
      if (create) using (var security = new PrivateSecurity(true)) {
        if (!CreateDirectoryW(path, ref security.Value)) {
          int error = Marshal.GetLastWin32Error(); if (error != 183) throw new Win32Exception(error);
        }
      }
      using (var file = Open(path, ReadAttributes | ReadControl, ShareRead | ShareWrite, !create)) {
        if (file != null) { CheckObject(file, path, true); CheckPrivate(file); }
      }
    }
  }
  public static string Read(string input, int cap, bool privateParent) {
    string path = Canonical(input);
    using (var parents = new Parents(path)) {
      if (privateParent) PrivateDirectory(Path.GetDirectoryName(path));
      using (var file = PrivateFile(path, false, ShareRead)) {
        var info = CheckObject(file, path, false);
        if (cap < 0 || cap > 16384 || info.SizeHigh != 0 || info.SizeLow > cap) throw new IOException("Oversized workspace identity");
        using (var stream = new FileStream(file, FileAccess.Read)) {
          byte[] bytes = new byte[cap + 1]; int count = 0, read;
          while (count < bytes.Length && (read = stream.Read(bytes, count, bytes.Length - count)) != 0) count += read;
          if (count > cap) throw new IOException("Oversized workspace identity");
          return Convert.ToBase64String(bytes, 0, count);
        }
      }
    }
  }
  public static void Remove(string input, bool privateParent) {
    string path = Canonical(input);
    using (var parents = new Parents(path)) {
      if (privateParent) PrivateDirectory(Path.GetDirectoryName(path));
      using (var file = Open(path, GenericRead | ReadControl | Delete, ShareRead, true)) {
        if (file == null) return;
        CheckObject(file, path, false); CheckPrivate(file);
        IntPtr disposition = Marshal.AllocHGlobal(1);
        try {
          Marshal.WriteByte(disposition, 1);
          if (!SetFileInformationByHandle(file, 4 /* FileDispositionInfo */, disposition, 1)) throw new Win32Exception();
        } finally { Marshal.FreeHGlobal(disposition); }
      }
    }
  }
  static SafeFileHandle Create(string path) {
    using (var security = new PrivateSecurity(false)) {
      var file = CreateFileW(path, GenericWrite | ReadControl | Delete, 0, security.Pointer, CreateNew, OpenReparse, IntPtr.Zero);
      if (file.IsInvalid) { int error = Marshal.GetLastWin32Error(); file.Dispose(); throw new Win32Exception(error); }
      try { CheckObject(file, path, false); CheckPrivate(file); return file; }
      catch { file.Dispose(); throw; }
    }
  }
  static void Rename(SafeFileHandle file, string path, bool replace = true) {
    byte[] name = Encoding.Unicode.GetBytes(path);
    int offset = (int)Marshal.OffsetOf(typeof(RenameInformation), "Name");
    // The Win32 path conversion needs a terminated string; Length excludes its NUL.
    int size = offset + name.Length + 2;
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      // Zero padding as well as RootDirectory; use the pinned absolute destination.
      // REPLACE_IF_EXISTS | POSIX_SEMANTICS permits replacing the destination while
      // its verified read handle stays open. Never close it to make rename work.
      Marshal.Copy(new byte[size], 0, memory, size); Marshal.WriteInt32(memory, replace ? 3 : 0);
      Marshal.WriteInt32(memory, (int)Marshal.OffsetOf(typeof(RenameInformation), "Length"), name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(memory, offset), name.Length);
      if (!SetFileInformationByHandle(file, 22 /* FileRenameInfoEx */, memory, (uint)size)) {
        int error = Marshal.GetLastWin32Error(); throw new Win32Exception(error, "Cannot rename workspace checkpoint (" + error + ")");
      }
    } finally { Marshal.FreeHGlobal(memory); }
  }
  public static void Migrate(string input, string destination) {
    string source = Canonical(input), target = Canonical(destination);
    using (var sourceParents = new Parents(source))
    using (var targetParents = new Parents(target)) {
      PrivateDirectory(Path.GetDirectoryName(target));
      using (var file = Open(source, GenericRead | ReadControl | Delete, ShareRead, false)) {
        CheckObject(file, source, false); CheckPrivate(file);
        // Rename the verified object itself. An existing destination is never replaced.
        Rename(file, target, false);
      }
    }
  }
  public static void Write(string input, string content, bool replace, bool privateParent) {
    string path = Canonical(input); byte[] bytes = Convert.FromBase64String(content);
    if (bytes.Length > 16384) throw new IOException("Oversized workspace identity");
    using (var parents = new Parents(path)) {
      // Only checkpoint replacement is allowed, inside the already-private store.
      if (replace || privateParent) PrivateDirectory(Path.GetDirectoryName(path));
      using (var previous = replace ? PrivateFile(path, true, ShareRead | ShareDelete) : null) {
        string temporary = replace ? path + "." + Guid.NewGuid().ToString("N") + ".tmp" : path;
        using (var file = Create(temporary))
        using (var stream = new FileStream(file, FileAccess.Write)) {
          stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
          if (replace) Rename(file, path);
        }
      }
    }
  }
}

// Destroy-only OS evidence. Each signal uses a process handle whose creation
// time was checked after a fresh handle scan; PIDs and lease files alone do not
// authorize termination. Handles for unrelated inaccessible processes are skipped.
public static class CezDestroyHolders {
  const uint Query = 0x1000, Duplicate = 0x40, Terminate = 1, SameAccess = 2;
  const int ExtendedHandles = 64;
  const int LengthMismatch = unchecked((int)0xC0000004);
  [StructLayout(LayoutKind.Sequential)] struct Entry {
    public IntPtr Object, Pid, Handle;
    public uint Access; public ushort Trace, Type; public uint Attributes, Reserved;
  }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr data, int size, out int needed);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out SafeFileHandle copy, uint access, bool inherit, uint flags);
  [DllImport("kernel32.dll")] static extern uint GetFileType(SafeFileHandle handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);

  static string Token(IntPtr process) {
    long creation, exit, kernel, user;
    return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? creation.ToString() : null;
  }
  static string Normalize(string path) {
    if (path.StartsWith("\\\\?\\")) path = path.Substring(4);
    return Path.GetFullPath(path).TrimEnd('\\');
  }
  static bool Under(string name, string[] roots) {
    string path;
    try { path = Normalize(name); } catch { return false; }
    foreach (string root in roots) {
      string canonical = Normalize(root);
      if (String.Equals(path, canonical, StringComparison.OrdinalIgnoreCase) ||
          path.StartsWith(canonical + "\\", StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }
  public static string[] Find(string[] roots, int selectedPid) {
    int size = 1024 * 1024, needed, status; IntPtr data = IntPtr.Zero;
    try {
      do {
        if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
        if (size > 256 * 1024 * 1024) { data = IntPtr.Zero; throw new IOException("Windows handle scan exceeds limit"); }
        data = Marshal.AllocHGlobal(size);
        status = NtQuerySystemInformation(ExtendedHandles, data, size, out needed);
        if (status == LengthMismatch) size = Math.Max(size * 2, needed);
      } while (status == LengthMismatch);
      if (status != 0) throw new IOException("Windows handle scan failed: " + status);
      long count = Marshal.ReadIntPtr(data).ToInt64(); int entrySize = Marshal.SizeOf(typeof(Entry));
      if (count < 0 || count > (size - IntPtr.Size * 2) / entrySize) throw new IOException("Invalid Windows handle scan");
      var processes = new Dictionary<int, IntPtr>(); var found = new Dictionary<int, string>();
      int self = System.Diagnostics.Process.GetCurrentProcess().Id;
      try {
        if (selectedPid != 0) {
          IntPtr selected = OpenProcess(Query | Duplicate, false, selectedPid);
          if (selected == IntPtr.Zero && Marshal.GetLastWin32Error() != 87) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect Windows holder " + selectedPid);
          processes[selectedPid] = selected;
        }
        for (long i = 0; i < count; i++) {
          var entry = (Entry)Marshal.PtrToStructure(IntPtr.Add(data, checked(IntPtr.Size * 2 + (int)i * entrySize)), typeof(Entry));
          long value = entry.Pid.ToInt64(); if (value <= 1 || value > Int32.MaxValue) continue;
          int pid = (int)value;
          if (pid == self || (selectedPid != 0 && pid != selectedPid) || found.ContainsKey(pid)) continue;
          IntPtr process;
          if (!processes.TryGetValue(pid, out process)) { process = OpenProcess(Query | Duplicate, false, pid); processes[pid] = process; }
          if (process == IntPtr.Zero) continue;
          SafeFileHandle copy;
          if (!DuplicateHandle(process, entry.Handle, GetCurrentProcess(), out copy, 0, false, SameAccess)) {
            int error = Marshal.GetLastWin32Error();
            if (selectedPid != 0 && error == 5) throw new Win32Exception(error, "Cannot inspect Windows holder handle " + pid);
            continue;
          }
          using (copy) {
            if (GetFileType(copy) != 1) continue;
            var name = new StringBuilder(32768); uint length = GetFinalPathNameByHandleW(copy, name, (uint)name.Capacity, 0);
            if (length == 0 || length >= name.Capacity) {
              if (selectedPid != 0 && Marshal.GetLastWin32Error() == 5) throw new IOException("Cannot name Windows holder handle " + pid);
              continue;
            }
            if (!Under(name.ToString(), roots)) continue;
            string token = Token(process); if (token == null) throw new IOException("Cannot verify Windows holder " + pid);
            found[pid] = token;
          }
        }
        var result = new List<string>(); foreach (var item in found) result.Add(item.Key + ":" + item.Value); return result.ToArray();
      } finally { foreach (IntPtr process in processes.Values) if (process != IntPtr.Zero) CloseHandle(process); }
    } finally { if (data != IntPtr.Zero) Marshal.FreeHGlobal(data); }
  }
  public static void Stop(string[] roots, int pid, string token) {
    IntPtr process = OpenProcess(Query | Terminate, false, pid);
    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open Windows holder " + pid);
    try {
      if (Token(process) != token || Array.IndexOf(Find(roots, pid), pid + ":" + token) < 0 || Token(process) != token) return;
      if (!TerminateProcess(process, 1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot stop Windows holder " + pid);
    } finally { CloseHandle(process); }
  }
}
