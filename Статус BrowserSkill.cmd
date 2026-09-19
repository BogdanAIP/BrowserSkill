@echo off
title BrowserSkill - ??????

echo.
echo ===== OPENAI TUNNEL =====
"C:\Users\eahra\AppData\Local\ChatAgentPlatform\bin\tunnel-client.exe" runtimes status browserskill --json

echo.
echo ===== BSK =====
set BSK_AUTO_START=0
"C:\Users\eahra\.local\bin\bsk.exe" status --json

echo.
pause
