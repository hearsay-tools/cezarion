$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'windows-workspace-identity.cs')
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ($request.operation) {
  'directory' { [CezWorkspaceIdentity]::Directory($request.path, [bool]$request.create) }
  'read' { [CezWorkspaceIdentity]::Read($request.path, [int]$request.cap, [bool]$request.privateParent) }
  'write' { [CezWorkspaceIdentity]::Write($request.path, $request.content, [bool]$request.replace, [bool]$request.privateParent) }
  default { throw 'Unknown workspace identity operation' }
}
