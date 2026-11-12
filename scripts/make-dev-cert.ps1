# Creates a local HTTPS certificate so phones on the same Wi-Fi can use the camera and microphone.
# Browsers only allow camera/microphone on HTTPS (or http://localhost).
#
# Output (in ./certificates, git-ignored):
#   ca.pem / ca-key.pem      local certificate authority (install ca.crt on a phone to remove the warning)
#   ca.crt                   same CA in the format phones install
#   cert.pem / key.pem       server certificate for localhost + this PC's LAN IPs
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/make-dev-cert.ps1 [-ExtraIp 192.168.1.20]
param([string[]]$ExtraIp = @())

$ErrorActionPreference = 'Stop'
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (-not $openssl) { $openssl = "$env:ProgramFiles\Git\usr\bin\openssl.exe" }
if (-not (Test-Path -LiteralPath $openssl)) { throw 'openssl not found (install Git for Windows or OpenSSL).' }

$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'certificates'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { $_.IPAddress }) + $ExtraIp | Select-Object -Unique
$san = (@('DNS:localhost', 'IP:127.0.0.1') + ($ips | ForEach-Object { "IP:$_" })) -join ','

# openssl prints progress on stderr; Windows PowerShell would treat that as a failure under 'Stop'.
$ErrorActionPreference = 'Continue'
Push-Location $dir
try {
  if (-not (Test-Path 'ca.pem')) {
    & $openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out ca.pem -days 825 `
      -subj '/CN=VoxTab Local Dev CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>$null
  }
  if (-not (Test-Path 'ca.crt')) { & $openssl x509 -in ca.pem -outform der -out ca.crt }
  & $openssl req -newkey rsa:2048 -nodes -keyout key.pem -out server.csr -subj '/CN=VoxTab Dev Server' 2>$null
  Set-Content -LiteralPath ext.cnf -Encoding ascii -Value @(
    "subjectAltName=$san",
    'basicConstraints=CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth'
  )
  & $openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out cert.pem -days 825 -extfile ext.cnf 2>$null
  Remove-Item server.csr, ext.cnf -ErrorAction SilentlyContinue
  if (-not (Test-Path 'cert.pem') -or -not (Test-Path 'key.pem')) { throw 'Certificate generation failed.' }
} finally { Pop-Location }

Write-Host "Certificate created for: $san"
$lan = ($ips | Where-Object { $_ -like '192.168.*' -or $_ -like '10.*' } | Select-Object -First 1)
if (-not $lan) { $lan = $ips | Select-Object -First 1 }
Write-Host "Start with: npm run dev:https   then open https://${lan}:3000 on your phone."
