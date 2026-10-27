$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'windows-workspace-identity.cs')
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ($request.operation) {
  'directory' { [CezWorkspaceIdentity]::Directory($request.path, [bool]$request.create) }
  'read' { [CezWorkspaceIdentity]::Read($request.path, [int]$request.cap, [bool]$request.privateParent) }
  'read-either' { [CezWorkspaceIdentity]::ReadEither($request.legacy, $request.current, [int]$request.cap) }
  'write' { [CezWorkspaceIdentity]::Write($request.path, $request.content, [bool]$request.replace, [bool]$request.privateParent) }
  'remove' { [CezWorkspaceIdentity]::Remove($request.path, [bool]$request.privateParent) }
  'migrate' { [CezWorkspaceIdentity]::Migrate($request.path, $request.destination) }
  'holders' { ConvertTo-Json -InputObject @([CezDestroyHolders]::Find([string[]]$request.paths, [int]$request.pid)) -Compress }
  'stop-holder' { [CezDestroyHolders]::Stop([string[]]$request.paths, [int]$request.pid, [string]$request.token) }
  default { throw 'Unknown workspace identity operation' }
}
