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
  static SafeFileHandle Create(string path) {
    using (var security = new PrivateSecurity(false)) {
      var file = CreateFileW(path, GenericWrite | ReadControl | Delete, 0, security.Pointer, CreateNew, OpenReparse, IntPtr.Zero);
      if (file.IsInvalid) { int error = Marshal.GetLastWin32Error(); file.Dispose(); throw new Win32Exception(error); }
      try { CheckObject(file, path, false); CheckPrivate(file); return file; }
      catch { file.Dispose(); throw; }
    }
  }
  static void Rename(SafeFileHandle file, string path) {
    byte[] name = Encoding.Unicode.GetBytes(path);
    int offset = (int)Marshal.OffsetOf(typeof(RenameInformation), "Name");
    // The Win32 path conversion needs a terminated string; Length excludes its NUL.
    int size = offset + name.Length + 2;
    IntPtr memory = Marshal.AllocHGlobal(size);
    try {
      // Zero padding as well as RootDirectory; use the pinned absolute destination.
      // REPLACE_IF_EXISTS | POSIX_SEMANTICS permits replacing the destination while
      // its verified read handle stays open. Never close it to make rename work.
      Marshal.Copy(new byte[size], 0, memory, size); Marshal.WriteInt32(memory, 3);
      Marshal.WriteInt32(memory, (int)Marshal.OffsetOf(typeof(RenameInformation), "Length"), name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(memory, offset), name.Length);
      if (!SetFileInformationByHandle(file, 22 /* FileRenameInfoEx */, memory, (uint)size)) {
        int error = Marshal.GetLastWin32Error(); throw new Win32Exception(error, "Cannot rename workspace checkpoint (" + error + ")");
      }
    } finally { Marshal.FreeHGlobal(memory); }
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
