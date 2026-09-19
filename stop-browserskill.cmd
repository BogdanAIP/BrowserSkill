@echo off
"C:\Users\eahra\AppData\Local\ChatAgentPlatform\bin\tunnel-client.exe" runtimes stop browserskill > "%LOCALAPPDATA%\BrowserSkill-ChatGPT\stop.log" 2>&1
"C:\Users\eahra\.local\bin\bsk.exe" daemon stop >> "%LOCALAPPDATA%\BrowserSkill-ChatGPT\stop.log" 2>&1
exit /b
