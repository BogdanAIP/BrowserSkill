@echo off
title BrowserSkill - ?????????

"C:\Users\eahra\AppData\Local\ChatAgentPlatform\bin\tunnel-client.exe" runtimes stop browserskill

"C:\Users\eahra\.local\bin\bsk.exe" daemon stop >nul 2>&1

echo.
echo BrowserSkill ????????.
timeout /t 2 /nobreak >nul
