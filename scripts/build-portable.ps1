$ErrorActionPreference = 'Stop'
$routerRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$suiteRoot = (Resolve-Path (Join-Path $routerRoot '..')).Path
$destination = Join-Path $routerRoot 'dist\portable-preview'
if (Test-Path -LiteralPath $destination) { throw 'Portable output already exists; preserve it or choose a fresh output location.' }
$mcpRoot = Join-Path $suiteRoot 'toolbox-mcp'
$widgetsRoot = Join-Path $suiteRoot 'toolbox-widgets'
$node = (Get-Command node.exe -ErrorAction Stop).Source
foreach ($required in @((Join-Path $mcpRoot 'dist\index.js'), (Join-Path $widgetsRoot 'dist\index.js'), (Join-Path $routerRoot 'node_modules'))) {
  if (!(Test-Path -LiteralPath $required)) { throw 'Build Router, Toolbox MCP, and toolbox-widgets dependencies before packaging.' }
}
New-Item -ItemType Directory -Path $destination | Out-Null
function Copy-Tree([string]$source,[string]$target) {
  & robocopy.exe $source $target /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'A portable package copy failed.' }
}
Copy-Item -LiteralPath $node -Destination (Join-Path $destination 'node.exe')
foreach ($dir in @('src','scripts','node_modules')) { Copy-Tree (Join-Path $routerRoot $dir) (Join-Path $destination "router\$dir") }
Copy-Item -LiteralPath (Join-Path $routerRoot 'package.json') -Destination (Join-Path $destination 'router\package.json')
Copy-Item -LiteralPath (Join-Path $routerRoot 'README.md') -Destination (Join-Path $destination 'router\README.md')
New-Item -ItemType Directory -Path (Join-Path $destination 'mcp\dist') -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $mcpRoot 'dist') -File -Filter '*.js' | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destination 'mcp\dist')
}
Copy-Tree (Join-Path $mcpRoot 'node_modules') (Join-Path $destination 'mcp\node_modules')
Copy-Item -LiteralPath (Join-Path $mcpRoot 'package.json') -Destination (Join-Path $destination 'mcp\package.json')
Copy-Tree (Join-Path $widgetsRoot 'dist') (Join-Path $destination 'mcp\node_modules\@toolbox\widgets\dist')
Copy-Tree (Join-Path $widgetsRoot 'node_modules') (Join-Path $destination 'mcp\node_modules\@toolbox\widgets\node_modules')
Copy-Item -LiteralPath (Join-Path $widgetsRoot 'package.json') -Destination (Join-Path $destination 'mcp\node_modules\@toolbox\widgets\package.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable-start.cmd') -Destination (Join-Path $destination 'Start Router.cmd')
Write-Output "Portable Router created: $destination"
