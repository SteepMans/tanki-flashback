# Запуск сервера отдельным фоновым процессом.
#
# Отладочная консоль сервера читает stdin. Если stdin закрыт, она получает EOF и гасит процесс
# ("Exiting server..."), поэтому здесь stdin подменяется на NUL-устройство, которое EOF не отдаёт,
# а stdout/stderr уходят в dev.log.
#
#   .\run-server.ps1            запуск без пересборки ресурсов
#   .\run-server.ps1 -Build     с пересборкой ресурсов
#   .\run-server.ps1 -Stop      остановить

param([switch]$Build, [switch]$Stop)

$root = $PSScriptRoot
$log = Join-Path $root "dev.log"

function Stop-Server {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like "*tanki-classic-2*" }
    foreach ($p in $procs) {
        Write-Host "stopping $($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Stop-Server
if ($Stop) { return }

Start-Sleep -Seconds 2

$flag = if ($Build) { "--build" } else { "--no-build" }
$cmd = "npm run dev -- $flag > `"$log`" 2>&1 < NUL"

Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd `
    -WorkingDirectory $root -WindowStyle Hidden

Write-Host "started, log: $log"
