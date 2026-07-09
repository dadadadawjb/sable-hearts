$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..

$env:PORT = if ($env:PORT) { $env:PORT } else { '3000' }
$node = (Get-Command node -ErrorAction Stop).Source

& $node 'node_modules\tsx\dist\cli.mjs' 'src\server\index.ts' *> 'logs\server.combined.log'
