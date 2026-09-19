$Tunnel =
    "C:\Users\eahra\AppData\Local\ChatAgentPlatform\bin\tunnel-client.exe"

$TunnelId =
    "tunnel_6aad872664188191be3dcffdf11d978d"

$KeyFile =
    "$env:LOCALAPPDATA\BrowserSkill-ChatGPT\tunnel-runtime.key"

$Project =
    "$HOME\Desktop\BrowserSkill-ChatGPT"

$Log =
    "$env:LOCALAPPDATA\BrowserSkill-ChatGPT\tray-start.log"

New-Item `
    -ItemType Directory `
    -Path (Split-Path $Log) `
    -Force |
    Out-Null

$Node =
    ((Get-Command node.exe).Source -replace '\\','/')

$Server =
    ((Resolve-Path "$Project\src\index.mjs").Path -replace '\\','/')

$McpCommand =
    "`"$Node`" `"$Server`""

& $Tunnel `
    runtimes connect `
    --alias browserskill `
    --tunnel-id $TunnelId `
    --runtime-api-key "file:$KeyFile" `
    --mcp-command $McpCommand `
    --json `
    *> $Log
