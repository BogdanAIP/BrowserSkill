Set shell = CreateObject("WScript.Shell")
shell.Run Chr(34) & "C:\Program Files\PowerShell\7\pwsh.exe" & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & "C:\Users\eahra\Desktop\BrowserSkill-ChatGPT\BrowserSkill-Tray.ps1" & Chr(34), 0, False
