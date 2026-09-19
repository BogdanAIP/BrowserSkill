@echo off
"C:\Users\eahra\AppData\Local\ChatAgentPlatform\bin\tunnel-client.exe" runtimes connect --alias browserskill --profile browserskill --profile-dir "%APPDATA%\tunnel-client" > "%LOCALAPPDATA%\BrowserSkill-ChatGPT\start.log" 2>&1
exit /b
