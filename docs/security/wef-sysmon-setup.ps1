<#
.SYNOPSIS
    Подготовка контроллера домена как источника событий безопасности:
    расширенный аудит, размеры журналов, WinRM и подписка WEF, установка Sysmon.

.DESCRIPTION
    Скрипт для Windows Server 2012 R2 / PowerShell 4.0. Выполняет только
    компенсирующие меры обнаружения: журналы, аудит, Sysmon и отправку событий
    на сервер-коллектор. Антивирус не ставит и политики безопасности не меняет.

    Порядок применения:
      1. Сначала на сервере-коллекторе создать подписку WEF (wecutil) и получить URL.
      2. Запустить скрипт на контроллере домена с параметром -CollectorUrl.
      3. Проверить, что события доходят: Get-WinEvent на коллекторе.

.PARAMETER CollectorUrl
    URL коллектора WEF, например http://SRV-LOG-01.EcoChim.local:5985/wsman/SubscriptionManager/WEC
    Без этого параметра отправка событий не настраивается (аудит и Sysmon настраиваются).

.PARAMETER SysmonPath
    Путь к sysmon.exe (13.x или 14.x — та версия, что поддерживает 2012 R2).
    Без параметра Sysmon не устанавливается.

.PARAMETER SysmonConfig
    Путь к конфигурации Sysmon, по умолчанию sysmon-dc.xml рядом со скриптом.

.EXAMPLE
    .\wef-sysmon-setup.ps1 -CollectorUrl http://SRV-LOG-01.EcoChim.local:5985/wsman/SubscriptionManager/WEC `
                           -SysmonPath C:\Install\sysmon\sysmon64.exe

.NOTES
    Запускать от имени администратора домена. Каждый шаг независим: ошибка в одном
    не прерывает остальные и попадает в итоговый отчёт.
#>
[CmdletBinding()]
param(
    [string]$CollectorUrl = '',
    [string]$SysmonPath = '',
    [string]$SysmonConfig = '',
    [switch]$SkipAuditPolicy,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
$report = @()
$script:failures = 0

function Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host ("`n== " + $Name) -ForegroundColor Cyan
    try {
        & $Action
        $script:report += [pscustomobject]@{ Шаг = $Name; Результат = 'ок'; Детали = '' }
    } catch {
        $script:failures++
        $message = $_.Exception.Message
        Write-Host ("  ошибка: " + $message) -ForegroundColor Red
        $script:report += [pscustomobject]@{ Шаг = $Name; Результат = 'ошибка'; Детали = $message }
    }
}

function Invoke-AuditPol {
    param([string]$SubcategoryGuid, [string]$Settings, [string]$Title)
    $auditArgs = @('/set', ('/subcategory:' + $SubcategoryGuid), $Settings)
    $result = & auditpol.exe @auditArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("auditpol " + $Title + ": " + ($result -join ' '))
    }
    Write-Host ("  " + $Title + " -> " + $Settings)
}

# --- 1. Расширенная политика аудита (по GUID, чтобы не зависеть от языка ОС)
if (-not $SkipAuditPolicy) {
    Step 'Политика аудита: вход и учётные записи' {
        Invoke-AuditPol '{0CCE9215-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Logon'
        Invoke-AuditPol '{0CCE9216-69AE-11D9-BED3-505054503030}' 'success:enable' 'Logoff'
        Invoke-AuditPol '{0CCE921B-69AE-11D9-BED3-505054503030}' 'success:enable' 'Special Logon'
        Invoke-AuditPol '{0CCE921C-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Other Logon/Logoff Events'
        Invoke-AuditPol '{0CCE923F-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Credential Validation'
        Invoke-AuditPol '{0CCE9242-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Kerberos Authentication Service'
        Invoke-AuditPol '{0CCE9240-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Kerberos Service Ticket Operations'
    }

    Step 'Политика аудита: изменения в каталоге и политиках' {
        Invoke-AuditPol '{0CCE9235-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'User Account Management'
        Invoke-AuditPol '{0CCE9237-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Security Group Management'
        Invoke-AuditPol '{0CCE9236-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Computer Account Management'
        Invoke-AuditPol '{0CCE923B-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Directory Service Access'
        Invoke-AuditPol '{0CCE923C-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Directory Service Changes'
        Invoke-AuditPol '{0CCE922F-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Audit Policy Change'
        Invoke-AuditPol '{0CCE9230-69AE-11D9-BED3-505054503030}' 'success:enable failure:enable' 'Authentication Policy Change'
    }

    Step 'Политика аудита: создание процессов с командной строкой' {
        Invoke-AuditPol '{0CCE922B-69AE-11D9-BED3-505054503030}' 'success:enable' 'Process Creation'
        $auditKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\Audit'
        if (-not (Test-Path $auditKey)) { New-Item -Path $auditKey -Force | Out-Null }
        New-ItemProperty -Path $auditKey -Name 'ProcessCreationIncludeCmdLine_Enabled' -Value 1 `
            -PropertyType DWord -Force | Out-Null
        Write-Host '  командная строка в событии 4688 включена'
    }

    Step 'Политика аудита: сетевые подключения' {
        Invoke-AuditPol '{0CCE9226-69AE-11D9-BED3-505054503030}' 'success:enable' 'Filtering Platform Connection'
    }
}

# --- 2. Размеры журналов: чтобы события не затирались до разбора
Step 'Размеры журналов' {
    $logs = @{
        'Security'                                    = 1073741824  # 1 ГБ
        'System'                                      = 268435456   # 256 МБ
        'Application'                                 = 268435456
        'Microsoft-Windows-Sysmon/Operational'        = 536870912   # 512 МБ
        'Microsoft-Windows-PowerShell/Operational'    = 268435456
        'Microsoft-Windows-TaskScheduler/Operational' = 134217728
    }
    foreach ($log in $logs.Keys) {
        & wevtutil.exe sl $log ('/ms:' + $logs[$log]) 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Host ("  пропущено (нет журнала): " + $log) }
        else { Write-Host ("  " + $log + " -> " + [string]($logs[$log] / 1MB) + " МБ") }
    }
}

# --- 3. WinRM как транспорт для WEF
Step 'WinRM для пересылки событий' {
    $service = Get-Service -Name WinRM -ErrorAction Stop
    if ($service.Status -ne 'Running') { Start-Service -Name WinRM }
    Set-Service -Name WinRM -StartupType Automatic
    & winrm.exe quickconfig -quiet 2>&1 | Out-Null
    Write-Host ('  WinRM: ' + (Get-Service -Name WinRM).Status)
}

# --- 4. Адрес коллектора WEF
if ([string]::IsNullOrEmpty($CollectorUrl)) {
    Write-Host "`n== Отправка событий: пропущено, не задан -CollectorUrl" -ForegroundColor Yellow
    $script:report += [pscustomobject]@{ Шаг = 'Настройка коллектора WEF'; Результат = 'пропущено'; Детали = 'параметр -CollectorUrl не задан' }
} else {
    Step 'Настройка коллектора WEF' {
        $key = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\EventLog\EventForwarding\SubscriptionManager'
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        $value = 'Server=' + $CollectorUrl + ',Refresh=60'
        New-ItemProperty -Path $key -Name '1' -Value $value -PropertyType String -Force | Out-Null
        Write-Host ('  подписка: ' + $value)
        Restart-Service -Name WinRM -Force
        Start-Sleep -Seconds 3
        Write-Host '  WinRM перезапущен, источник готов отдавать события коллектору'
    }
}

# --- 5. Sysmon
if ([string]::IsNullOrEmpty($SysmonPath)) {
    Write-Host "`n== Sysmon: пропущено, не задан -SysmonPath" -ForegroundColor Yellow
    $script:report += [pscustomobject]@{ Шаг = 'Установка Sysmon'; Результат = 'пропущено'; Детали = 'параметр -SysmonPath не задан' }
} else {
    Step 'Установка Sysmon' {
        if (-not (Test-Path $SysmonPath)) { throw ('файл не найден: ' + $SysmonPath) }
        if ([string]::IsNullOrEmpty($SysmonConfig)) { $SysmonConfig = Join-Path $PSScriptRoot 'sysmon-dc.xml' }
        & $SysmonPath -accepteula -i $SysmonConfig 2>&1 | ForEach-Object { Write-Host ('  ' + $_) }
        Start-Sleep -Seconds 5
        $service = Get-Service -Name 'Sysmon64' -ErrorAction SilentlyContinue
        if ($null -eq $service) { $service = Get-Service -Name 'Sysmon' -ErrorAction SilentlyContinue }
        if ($null -eq $service) { throw 'служба Sysmon не появилась' }
        Write-Host ('  служба: ' + $service.Name + ', состояние: ' + $service.Status)
    }
}

# --- 6. Проверка результата
Step 'Проверка' {
    Write-Host '  аудит (первые категории):'
    & auditpol.exe /get /category:* 2>&1 | Select-Object -First 12 | ForEach-Object { Write-Host ('    ' + $_) }
    $security = Get-WinEvent -LogName Security -MaxEvents 1 -ErrorAction SilentlyContinue
    if ($null -ne $security) { Write-Host ('  последнее событие Security: ' + $security.TimeCreated + ' #' + $security.Id) }
    $sysmon = Get-WinEvent -LogName 'Microsoft-Windows-Sysmon/Operational' -MaxEvents 1 -ErrorAction SilentlyContinue
    if ($null -ne $sysmon) { Write-Host ('  последнее событие Sysmon: ' + $sysmon.TimeCreated + ' #' + $sysmon.Id) }
    else { Write-Host '  Sysmon-журнал пока пуст (нет событий) — это нормально при первой установке' }
    Write-Host ('  WinRM: ' + (Get-Service -Name WinRM).Status)
}

# --- Итог
"`n================ ИТОГ ================"
$report | ForEach-Object {
    if ($_.Результат -eq 'ошибка') { Write-Host ($_.Шаг + ": " + $_.Результат + " — " + $_.Детали) -ForegroundColor Red }
    elseif ($_.Результат -eq 'пропущено') { Write-Host ($_.Шаг + ': пропущено') -ForegroundColor Yellow }
    else { Write-Host ($_.Шаг + ': ок') -ForegroundColor Green }
}
if ($script:failures -gt 0) {
    Write-Host ("`nШагов с ошибкой: " + $script:failures + ". Разберите вывод выше — остальные настройки применены.") -ForegroundColor Yellow
} else {
    Write-Host "`nВсе шаги выполнены. Дальше: проверить приход событий на коллекторе WEF." -ForegroundColor Green
}
