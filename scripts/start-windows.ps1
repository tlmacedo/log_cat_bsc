# Sobe o Log Viewer em container no Windows.
#
#   .\scripts\start-windows.ps1 [pasta-de-logs] [-Extras pasta1,pasta2]
#
# Sem argumento, usa a pasta log\ do repositorio. A pasta de logs, a sua pasta
# de usuario e o que vier em -Extras ficam visiveis no botao "Procurar...",
# somente leitura. No Windows cada unidade aparece como /c, /d... dentro do
# container, porque C:\ nao existe no Linux.
param([string]$LogDir = "", [string[]]$Extras = @())

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Repo = (Get-Location).Path
$Port = if ($env:HOST_PORT) { $env:HOST_PORT } else { "5057" }

function Info($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "OK $m" -ForegroundColor Green }
function Warn($m) { Write-Host "!  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "X  $m" -ForegroundColor Red; exit 1 }

# --- Docker ---------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Die "Docker nao encontrado. Instale o Docker Desktop: https://www.docker.com/products/docker-desktop"
}
try { docker info *> $null } catch {
  Die "O Docker esta instalado mas nao esta rodando. Abra o Docker Desktop e tente de novo."
}
try { docker compose version *> $null } catch {
  Die "Este Docker nao tem o 'docker compose'. Atualize o Docker Desktop."
}
Ok "Docker pronto"

# --- Pasta de logs --------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($LogDir)) { $LogDir = Join-Path $Repo "log" }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogDir = (Resolve-Path $LogDir).Path
$CaptureDir = Join-Path $Repo "capturas"
if (-not (Test-Path $CaptureDir)) { New-Item -ItemType Directory -Path $CaptureDir -Force | Out-Null }
$ConfigDir = Join-Path $Repo "config"
if (-not (Test-Path $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null }
Ok "Logs:     $LogDir  (aparece como /logs no app)"
Ok "Capturas: $CaptureDir"
Ok "Config:   $ConfigDir  (filtros salvos - versionados no git, sincronize com pull/push)"

# Pastas do host visiveis no botao "Procurar...". No Windows o caminho nao pode
# ser reproduzido igual (C:\ nao existe no Linux do container), entao cada
# unidade vira /c, /d... Sao somente leitura.
$Visiveis = @($LogDir, $env:USERPROFILE)
foreach ($e in $Extras) { if (Test-Path $e) { $Visiveis += (Resolve-Path $e).Path } }

$Linhas = @(
  "# Gerado por scripts/start-windows.ps1 - nao edite a mao.",
  "# Pastas do host visiveis dentro do container, somente leitura.",
  "services:", "  logviewer:", "    volumes:"
)
$Vistos = @()
foreach ($dir in $Visiveis) {
  if ([string]::IsNullOrWhiteSpace($dir)) { continue }
  $ja = $false
  foreach ($o in $Vistos) { if ($dir -eq $o -or $dir.StartsWith($o + "\")) { $ja = $true } }
  if ($ja) { continue }
  $Vistos += $dir
  # C:\Users\x  ->  /c/Users/x
  $destino = "/" + $dir.Substring(0,1).ToLower() + ($dir.Substring(2) -replace "\\", "/")
  $Linhas += ('      - "{0}:{1}:ro"' -f $dir, $destino)
}
$Linhas -join "`n" | Set-Content -Path "docker-compose.override.yml" -Encoding ASCII
Ok ("Visiveis: " + ($Vistos -join "  "))

# --- adb do host ----------------------------------------------------------
# O container nao enxerga a USB; ele conversa com o adb desta maquina.
$AdbBin = $null
$Candidates = @(
  "adb",
  (Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"),
  (Join-Path $env:USERPROFILE "AppData\Local\Android\Sdk\platform-tools\adb.exe"),
  "C:\platform-tools\adb.exe"
)
foreach ($c in $Candidates) {
  if (Get-Command $c -ErrorAction SilentlyContinue) { $AdbBin = $c; break }
  if (Test-Path $c) { $AdbBin = $c; break }
}

$AdbHostValue = "host.docker.internal"
if ($AdbBin) {
  # -a faz o servidor aceitar conexoes de fora do localhost, que e o caso do container.
  try { & $AdbBin -a -P 5037 start-server *> $null } catch {
    try { & $AdbBin start-server *> $null } catch { }
  }
  $Devs = 0
  try { $Devs = (& $AdbBin devices | Select-Object -Skip 1 | Where-Object { $_ -match "device$" }).Count } catch { }
  Ok "adb encontrado ($AdbBin) - $Devs aparelho(s) conectado(s)"
} else {
  $AdbHostValue = ""
  Warn "adb nao encontrado. O app sobe normalmente, mas a aba de aparelhos USB"
  Warn "ficara indisponivel. Para habilitar, instale as platform-tools do Android."
}

# --- Sobe --------------------------------------------------------------------
@"
LOG_DIR=$LogDir
CAPTURE_DIR=$CaptureDir
CONFIG_DIR=$ConfigDir
HOST_PORT=$Port
ADB_HOST=$AdbHostValue
ADB_PORT=5037
"@ | Set-Content -Path ".env" -Encoding ASCII

Info "Construindo a imagem (a primeira vez demora alguns minutos)..."
docker compose build
Info "Subindo o container..."
docker compose up -d

$Url = "http://127.0.0.1:$Port"
$Pronto = $false
foreach ($i in 1..60) {
  try {
    Invoke-WebRequest -Uri "$Url/api/config" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $Pronto = $true; break
  } catch { Start-Sleep -Seconds 1 }
}

if ($Pronto) {
  Ok "Log Viewer no ar em $Url"
  Start-Process $Url
} else {
  Warn "O container subiu mas o servidor nao respondeu. Veja: docker compose logs -f"
}

Write-Host ""
Write-Host "  parar:     docker compose down"
Write-Host "  logs:      docker compose logs -f"
Write-Host "  reiniciar: .\scripts\start-windows.ps1 `"$LogDir`""
