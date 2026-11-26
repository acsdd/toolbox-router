param([string]$OutputDirectory = 'dist\portable-candidate')
$ErrorActionPreference = 'Stop'
$routerRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$suiteRoot = (Resolve-Path (Join-Path $routerRoot '..')).Path
$destination = if ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path $routerRoot $OutputDirectory)) }
if (Test-Path -LiteralPath $destination) { throw 'Portable output already exists; preserve it or choose a fresh output location.' }
$mcpRoot = Join-Path $suiteRoot 'toolbox-mcp'
$widgetsRoot = Join-Path $suiteRoot 'toolbox-widgets'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $node --version).Trim()
$nodeLicense = Join-Path $routerRoot "licenses\node-$nodeVersion.txt"
if (!(Test-Path -LiteralPath $nodeLicense -PathType Leaf)) { throw "Add the official Node.js license for $nodeVersion at $nodeLicense before packaging." }
foreach ($required in @((Join-Path $mcpRoot 'dist\index.js'), (Join-Path $widgetsRoot 'dist\index.js'), (Join-Path $routerRoot 'node_modules'))) {
  if (!(Test-Path -LiteralPath $required)) { throw 'Build Router, Toolbox MCP, and toolbox-widgets dependencies before packaging.' }
}
New-Item -ItemType Directory -Path $destination | Out-Null
function Copy-Tree([string]$source,[string]$target) {
  & robocopy.exe $source $target /E /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'A portable package copy failed.' }
}
Copy-Item -LiteralPath $node -Destination (Join-Path $destination 'node.exe')
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $destination 'NODE-LICENSE.txt')
foreach ($dir in @('src','scripts','node_modules')) { Copy-Tree (Join-Path $routerRoot $dir) (Join-Path $destination "router\$dir") }
Copy-Item -LiteralPath (Join-Path $routerRoot 'package.json') -Destination (Join-Path $destination 'router\package.json')
Copy-Item -LiteralPath (Join-Path $routerRoot 'README.md') -Destination (Join-Path $destination 'router\README.md')
Copy-Item -LiteralPath (Join-Path $routerRoot 'LICENSE') -Destination (Join-Path $destination 'router\LICENSE')
New-Item -ItemType Directory -Path (Join-Path $destination 'mcp\dist') -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $mcpRoot 'dist') -File -Filter '*.js' | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destination 'mcp\dist')
}
Copy-Tree (Join-Path $mcpRoot 'node_modules') (Join-Path $destination 'mcp\node_modules')
Copy-Item -LiteralPath (Join-Path $mcpRoot 'package.json') -Destination (Join-Path $destination 'mcp\package.json')
Copy-Item -LiteralPath (Join-Path $mcpRoot 'LICENSE') -Destination (Join-Path $destination 'mcp\LICENSE')
Copy-Tree (Join-Path $widgetsRoot 'dist') (Join-Path $destination 'mcp\node_modules\@toolbox\widgets\dist')
Copy-Tree (Join-Path $widgetsRoot 'node_modules') (Join-Path $destination 'mcp\node_modules\@toolbox\widgets\node_modules')
Copy-Item -LiteralPath (Join-Path $widgetsRoot 'package.json') -Destination (Join-Path $destination 'mcp\node_modules\@toolbox\widgets\package.json')
Copy-Item -LiteralPath (Join-Path $widgetsRoot 'LICENSE') -Destination (Join-Path $destination 'mcp\node_modules\@toolbox\widgets\LICENSE')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable-start.cmd') -Destination (Join-Path $destination 'Start Router.cmd')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portable-setup-qoder.cmd') -Destination (Join-Path $destination 'Setup Qoder.cmd')
Write-Output "Portable Router created: $destination"
