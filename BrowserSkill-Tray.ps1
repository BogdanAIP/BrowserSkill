Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Project =
    Split-Path -Parent $MyInvocation.MyCommand.Path

$Tunnel =
    "C:\Users\eahra\AppData\Local\ChatAgentPlatform\bin\tunnel-client.exe"

$GreenIco =
    Join-Path $Project "browserskill-green.ico"

$RedIco =
    Join-Path $Project "browserskill-red.ico"

$StartPs1 =
    Join-Path $Project "start-runtime.ps1"

$StopPs1 =
    Join-Path $Project "stop-runtime.ps1"

$Pwsh =
    (Get-Command pwsh.exe).Source


$greenIcon =
    New-Object System.Drawing.Icon $GreenIco

$redIcon =
    New-Object System.Drawing.Icon $RedIco


$notify =
    New-Object System.Windows.Forms.NotifyIcon

$notify.Visible =
    $true


$menu =
    New-Object System.Windows.Forms.ContextMenuStrip

$itemStatus =
    $menu.Items.Add("BrowserSkill")

$itemStatus.Enabled =
    $false

[void]$menu.Items.Add("-")

$itemStart =
    $menu.Items.Add("Включить")

$itemStop =
    $menu.Items.Add("Выключить")

$itemRefresh =
    $menu.Items.Add("Проверить состояние")

[void]$menu.Items.Add("-")

$itemExit =
    $menu.Items.Add("Закрыть индикатор")

$notify.ContextMenuStrip =
    $menu


function Get-BrowserSkillState {

    try {

        $raw =
            & $Tunnel `
                runtimes status browserskill --json `
                2>$null

        if (-not $raw) {
            return $false
        }

        $data =
            $raw |
            ConvertFrom-Json

        return (
            $data.process_running -eq $true -and
            $data.healthy -eq $true -and
            $data.ready -eq $true
        )
    }
    catch {
        return $false
    }
}


function Set-On {

    $notify.Icon =
        $greenIcon

    $notify.Text =
        "BrowserSkill: ВКЛЮЧЕН"

    $itemStatus.Text =
        "BrowserSkill: ВКЛЮЧЕН"
}


function Set-Off {

    $notify.Icon =
        $redIcon

    $notify.Text =
        "BrowserSkill: ВЫКЛЮЧЕН"

    $itemStatus.Text =
        "BrowserSkill: ВЫКЛЮЧЕН"
}


function Update-State {

    if (Get-BrowserSkillState) {
        Set-On
        return
    }

    Set-Off
}


# Это НЕ периодический таймер.
# Он запускается только ОДИН РАЗ после нажатия кнопки.
$oneShot =
    New-Object System.Windows.Forms.Timer

$oneShot.Add_Tick({

    $oneShot.Stop()

    Update-State
})


function Check-Later {

    param(
        [int]$Milliseconds
    )

    $oneShot.Stop()

    $oneShot.Interval =
        $Milliseconds

    $oneShot.Start()
}


$itemStart.Add_Click({

    $itemStatus.Text =
        "BrowserSkill: запускается..."

    Start-Process `
        -FilePath $Pwsh `
        -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $StartPs1
        ) `
        -WindowStyle Hidden

    Check-Later 5000
})


$itemStop.Add_Click({

    $itemStatus.Text =
        "BrowserSkill: выключается..."

    Start-Process `
        -FilePath $Pwsh `
        -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            $StopPs1
        ) `
        -WindowStyle Hidden

    Check-Later 3000
})


$itemRefresh.Add_Click({

    $itemStatus.Text =
        "BrowserSkill: проверка..."

    Update-State

    $notify.BalloonTipTitle =
        "BrowserSkill"

    $notify.BalloonTipText =
        $notify.Text

    $notify.ShowBalloonTip(1500)
})


$notify.Add_DoubleClick({

    if (Get-BrowserSkillState) {

        $itemStatus.Text =
            "BrowserSkill: выключается..."

        Start-Process `
            -FilePath $Pwsh `
            -ArgumentList @(
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                $StopPs1
            ) `
            -WindowStyle Hidden

        Check-Later 3000
    }
    else {

        $itemStatus.Text =
            "BrowserSkill: запускается..."

        Start-Process `
            -FilePath $Pwsh `
            -ArgumentList @(
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                $StartPs1
            ) `
            -WindowStyle Hidden

        Check-Later 5000
    }
})


$itemExit.Add_Click({

    $oneShot.Stop()

    $notify.Visible =
        $false

    $notify.Dispose()

    $greenIcon.Dispose()
    $redIcon.Dispose()

    [System.Windows.Forms.Application]::Exit()
})


# Только одна проверка при запуске индикатора.
Update-State

[System.Windows.Forms.Application]::Run()

