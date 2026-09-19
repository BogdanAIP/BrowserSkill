$Tunnel =
    "C:\Users\eahra\AppData\Local\ChatAgentPlatform\bin\tunnel-client.exe"

$Bsk =
    "$HOME\.local\bin\bsk.exe"

$Log =
    "$env:LOCALAPPDATA\BrowserSkill-ChatGPT\tray-stop.log"

& $Tunnel `
    runtimes stop browserskill `
    *> $Log

$env:BSK_AUTO_START = "0"

& $Bsk `
    daemon stop `
    *>> $Log

Remove-Item `
    Env:BSK_AUTO_START `
    -ErrorAction SilentlyContinue
