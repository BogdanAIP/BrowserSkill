@echo off
title BrowserSkill - ??????

"C:\Users\eahra\AppData\Local\ChatAgentPlatform\bin\tunnel-client.exe" runtimes connect --alias browserskill --profile browserskill --profile-dir "%APPDATA%\tunnel-client"

timeout /t 2 /nobreak >nul

"C:\Users\eahra\AppData\Local\ChatAgentPlatform\bin\tunnel-client.exe" runtimes status browserskill --json

echo.
echo BrowserSkill ???????.
timeout /t 2 /nobreak >nul
