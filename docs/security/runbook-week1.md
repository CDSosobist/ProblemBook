# Runbook первой недели: krbtgt, спулер на DC, права на бэкапах

Три действия из критического трека (PB-2, PB-7, PB-33). Все команды рассчитаны на **PowerShell 4.0** и **Windows Server 2012 R2** (TITAN), запускаются **от имени администратора домена** в консоли на самом контроллере.

Общие правила:

1. **Сначала только проверки** — блоки «до» безопасны, их можно выполнять в рабочее время.
2. Каждое изменение — в окно обслуживания, с записью в журнал изменений (кто, когда, что).
3. Перед первым изменением убедиться, что есть свежая резервная копия состояния AD:
   `wbadmin get versions -backupTarget:<диск>` — если восстановление не проверялось, сначала проверить его (PB-27).
4. Не выполнять два изменения одновременно: если что-то пойдёт не так, будет непонятно, что именно.

---

## 1. Смена пароля krbtgt в два этапа (PB-2)

Смысл: хеш krbtgt позволяет выпускать билеты на любую учётную запись. Один сброс не помогает — старый ключ остаётся в силе, поэтому делают **два сброса** с паузой не меньше максимального времени жизни билета.

### Проверка до (безопасно в любое время)

```powershell
Import-Module ActiveDirectory

# Когда меняли пароль krbtgt и версия ключа
Get-ADUser krbtgt -Properties PasswordLastSet, Modified |
    Select-Object Name, PasswordLastSet, Modified

# Сколько живёт билет: от этого зависит пауза между сбросами
$dom = Get-ADDomain
$cfg = Get-ADObject $dom.DistinguishedName -Properties maxTicketAge, maxRenewAge
$hours = [math]::Round($cfg.maxTicketAge * 24, 1)
Write-Host ("Максимальное время жизни билета: " + $hours + " ч — пауза между сбросами не меньше этого значения, лучше 12-24 ч")

# Копия состояния AD (если ещё не делали сегодня)
wbadmin get versions
```

### Этап 1 — первый сброс

```powershell
Import-Module ActiveDirectory
$before = (Get-ADUser krbtgt -Properties PasswordLastSet).PasswordLastSet
Write-Host ("До сброса: " + $before)

# Пароль генерируем и НЕ сохраняем: он нужен только Kerberos, знать его не требуется
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$newPassword = [Convert]::ToBase64String($bytes)

Set-ADAccountPassword -Identity krbtgt -Reset `
    -NewPassword (ConvertTo-SecureString -AsPlainText $newPassword -Force)

Start-Sleep -Seconds 2
Get-ADUser krbtgt -Properties PasswordLastSet |
    Select-Object Name, PasswordLastSet
Write-Host 'Этап 1 выполнен. Следующий сброс — не раньше чем через 10-12 часов. Пользователи могут потребовать повторного входа.'
```

### Этап 2 — второй сброс (на следующий день)

```powershell
Import-Module ActiveDirectory
$last = (Get-ADUser krbtgt -Properties PasswordLastSet).PasswordLastSet
$elapsed = (Get-Date) - $last
Write-Host ("С прошлого сброса прошло: " + [math]::Round($elapsed.TotalHours, 1) + " ч")
if ($elapsed.TotalHours -lt 10) {
    Write-Warning 'Прошло меньше 10 часов — второй сброс делать рано. Дождитесь паузы.'
} else {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $newPassword = [Convert]::ToBase64String($bytes)
    Set-ADAccountPassword -Identity krbtgt -Reset `
        -NewPassword (ConvertTo-SecureString -AsPlainText $newPassword -Force)
    Write-Host 'Этап 2 выполнен: старый ключ krbtgt больше не действует.'
}
```

### Проверка после

```powershell
Import-Module ActiveDirectory
Get-ADUser krbtgt -Properties PasswordLastSet | Select-Object Name, PasswordLastSet

# Здоровье домена после сбросов
dcdiag /test:netlogons /test:replications
repadmin /replsummary

# Вход: открыть новую сессию под доменной учётной записью (не под текущей сохранённой)
# и проверить доступ к общей папке и к 1С
```

### Откат и что делать при проблемах

Отката нет — пароль krbtgt не восстанавливают. Если пользователи не могут войти: проверить синхронизацию времени (PB-39, разница больше 5 минут ломает Kerberos), журнал System на события KDC, и убедиться, что сброс не выполнялся во время отсутствия связи с контроллером.

Ожидаемое поведение: часть пользователей и служб однократно переподключатся, кэшированные билеты перестанут работать. Это нормально.

### Запись в журнал

Записать: дату и время обоих сбросов, кто выполнял, результат `dcdiag`. В карточке PB-2 поставить статус «На проверке».

---

## 2. Отключение службы печати на контроллере домена (PB-7)

### Проверка до (безопасно)

```powershell
# Состояние службы и её зависимости
Get-Service Spooler | Select-Object Name, Status, StartType
Get-Service Spooler | Select-Object -ExpandProperty DependentServices

# Есть ли вообще очереди печати на этом сервере
Get-Printer -ErrorAction SilentlyContinue |
    Select-Object Name, ShareName, Published, DriverName

# Роль сервера печати установлена?
Get-WindowsFeature -Name Print-Server, Print-Services -ErrorAction SilentlyContinue |
    Select-Object Name, InstallState

# Кто печатает через сервер: смотреть события службы печати за неделю
Get-WinEvent -LogName 'Microsoft-Windows-PrintService/Operational' -MaxEvents 50 -ErrorAction SilentlyContinue |
    Select-Object TimeCreated, Id, Message | Format-List
```

Если `Get-Printer` недоступен (роль печати не установлена), проверить реестр:

```powershell
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers' -ErrorAction SilentlyContinue |
    Select-Object PSChildName
```

### Изменение

```powershell
Set-Service Spooler -StartupType Disabled
Stop-Service Spooler -Force
Get-Service Spooler | Select-Object Name, Status, StartType
```

Дополнительно — закрыть установку драйверов печати непривилегированными пользователями (если применимо после патчей):

```powershell
$key = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Printers\PointAndPrint'
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
New-ItemProperty -Path $key -Name 'RestrictDriverInstallationToAdministrators' `
    -Value 1 -PropertyType DWord -Force | Out-Null
```

### Проверка после

```powershell
Get-Service Spooler | Select-Object Name, Status, StartType
Test-NetConnection -ComputerName localhost -Port 445 | Select-Object ComputerName, TcpTestSucceeded
# С рабочей станции: Get-Printer -ComputerName TITAN  (должно завершиться ошибкой)
# Пользователи печатают на локальные принтеры — проверить у 2-3 сотрудников
```

### Откат

```powershell
Set-Service Spooler -StartupType Automatic
Start-Service Spooler
Get-Service Spooler | Select-Object Status, StartType
```

### Риск

Если на DC были опубликованы общие очереди, печать через них прекратится. Перед отключением выяснить это по `Get-Printer` и событиям PrintService; при наличии очередей — сначала перенести их на отдельный сервер печати (роль из PB-47).

---

## 3. Снятие «Все: полный доступ» с резервных копий (PB-33)

### Проверка до (безопасно)

```powershell
# Права на уровне общего ресурса
foreach ($share in 'BACKUP','MSSQLBackup','FTPbackup') {
    Write-Host ("== " + $share) -ForegroundColor Cyan
    Get-SmbShareAccess -Name $share -ErrorAction SilentlyContinue
}

# Права NTFS на каталоги
Get-Acl 'D:\BACKUP' | Format-List Path, Owner, AccessToString
Get-Acl 'D:\MSSQLBackup' | Format-List Path, Owner, AccessToString
Get-Acl 'D:\FTPbackup' | Format-List Path, Owner, AccessToString

# Кто и под какой учётной записью делает резервные копии — ЭТО ВАЖНО, чтобы не отобрать доступ у бэкапа
Get-ScheduledTask | Where-Object {
    $_.Actions.Execute -match 'wbadmin|backup|veeam|robocopy|7z|sqlcmd'
} | Select-Object TaskName, @{n='Execute';e={$_.Actions.Execute}}, @{n='Principal';e={$_.Principal.UserId}}

# Проверка, что копии вообще создаются
wbadmin get versions
Get-ChildItem 'D:\MSSQLBackup' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, LastWriteTime, Length
```

Результат проверок **сохранить** — это и есть откат:

```powershell
New-Item -ItemType Directory -Force -Path 'C:\Temp\acl-backup' | Out-Null
foreach ($share in 'BACKUP','MSSQLBackup','FTPbackup') {
    Get-SmbShareAccess -Name $share | Export-Csv ("C:\Temp\acl-backup\" + $share + "-share.csv") -NoTypeInformation -Encoding UTF8
}
foreach ($path in 'D:\BACKUP','D:\MSSQLBackup','D:\FTPbackup') {
    $name = (Split-Path $path -Leaf)
    Get-Acl $path | Format-List * | Out-File ("C:\Temp\acl-backup\" + $name + "-ntfs.txt") -Encoding UTF8
}
```

### Изменение

```powershell
# Имена групп берём из SID: на русской ОС 'Everyone' и 'BUILTIN\Administrators' не разрешаются
function Get-AccountName([string]$sid) {
    (New-Object System.Security.Principal.SecurityIdentifier($sid)).Translate(
        [System.Security.Principal.NTAccount]).Value
}
$everyone = Get-AccountName 'S-1-1-0'        # «Все»
$admins   = Get-AccountName 'S-1-5-32-544'   # «Администраторы»
Write-Host ("Everyone: " + $everyone + " | Администраторы: " + $admins)

foreach ($share in 'BACKUP','MSSQLBackup','FTPbackup') {
    # админы — полный доступ, «Все» — убрать
    Grant-SmbShareAccess  -Name $share -AccountName $admins -AccessRight Full -Force
    Revoke-SmbShareAccess -Name $share -AccountName $everyone -Force
    Get-SmbShareAccess -Name $share
}

# NTFS: убрать «Все» из корня каталога (без /t — только корневая запись)
icacls "D:\BACKUP"      /remove:g "*S-1-1-0"
icacls "D:\MSSQLBackup" /remove:g "*S-1-1-0"
icacls "D:\FTPbackup"   /remove:g "*S-1-1-0"
```

Если бэкап ходит под отдельной учётной записью — выдать ей права явно:

```powershell
$backupAccount = 'ECOCHIM\backup'   # подставить фактическую учётную запись из проверки
foreach ($share in 'BACKUP','MSSQLBackup','FTPbackup') {
    Grant-SmbShareAccess -Name $share -AccountName $backupAccount -AccessRight Change -Force
}
icacls "D:\BACKUP"      /grant "${backupAccount}:(OI)(CI)M"
icacls "D:\MSSQLBackup" /grant "${backupAccount}:(OI)(CI)M"
icacls "D:\FTPbackup"   /grant "${backupAccount}:(OI)(CI)M"
```

### Проверка после

```powershell
foreach ($share in 'BACKUP','MSSQLBackup','FTPbackup') {
    Write-Host ("== " + $share) -ForegroundColor Cyan
    Get-SmbShareAccess -Name $share
}
Get-Acl 'D:\BACKUP' | Format-List AccessToString

# Резервная копия создаётся: запустить задание вручную или дождаться ночного и проверить свежий файл
Get-ChildItem 'D:\MSSQLBackup' | Sort-Object LastWriteTime -Descending |
    Select-Object -First 3 Name, LastWriteTime, Length

# С рабочей станции обычного пользователя доступ должен быть закрыт:
#   net use \\TITAN\BACKUP /user:ECOCHIM\ivanov   -> ожидается отказ 5
```

### Откат

```powershell
$everyone = (New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')).Translate(
    [System.Security.Principal.NTAccount]).Value
foreach ($share in 'BACKUP','MSSQLBackup','FTPbackup') {
    Grant-SmbShareAccess -Name $share -AccountName $everyone -AccessRight Full -Force
}
icacls "D:\BACKUP"      /grant "*S-1-1-0:(OI)(CI)R"
icacls "D:\MSSQLBackup" /grant "*S-1-1-0:(OI)(CI)R"
icacls "D:\FTPbackup"   /grant "*S-1-1-0:(OI)(CI)R"
```

### Риск

Главный — **сломать бэкап**: если задание ходит под учётной записью без прав, копии перестанут создаваться, и обнаружится это в момент восстановления. Поэтому сначала проверка «кто делает копии», потом изменение, и обязательно проверка свежего файла после.

---

## Порядок на неделю

| Когда | Что | Окно | Проверка успеха |
|---|---|---|---|
| Пн, вечер | krbtgt, этап 1 | 5 минут | `PasswordLastSet` обновился, `dcdiag` чистый |
| Вт, утро | krbtgt, этап 2 (пауза ≥10 ч) | 5 минут | повторный `dcdiag`, вход пользователей |
| Вт | Права на бэкапах: проверка «кто делает копии» | без окна | список копий и учётных записей зафиксирован |
| Ср | Права на бэкапах: изменение + ночная копия | 15 минут | свежий файл копии, отказ доступа у обычного пользователя |
| Чт | Спулер: проверка очередей и событий | без окна | нет активных общих очередей |
| Пт | Спулер: отключение | 10 минут | служба Disabled, печать у пользователей работает |

После каждой строки — запись в журнал изменений и обновление статуса карточки в проблембуке.
