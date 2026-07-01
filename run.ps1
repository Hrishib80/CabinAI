# run.ps1 — Launch CabinAI backend with Python 3.12 ARM64 (qai-hub compatible)
# Usage:
#   .\run.ps1            — start backend only
#   .\run.ps1 -frontend  — start backend + frontend + open browser
#   .\run.ps1 -export    — export Distil-Whisper model first, then start backend

param(
    [switch]$frontend,
    [switch]$export
)

$root      = $PSScriptRoot
$py312arm  = "C:\Users\vsahni\AppData\Local\Programs\Python\Python312-arm64\python.exe"
$py312venv = "$root\.venv312\Scripts\python.exe"
$npx       = "C:\Program Files\nodejs\npx.cmd"
$edge      = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# Kill any existing backend on port 5000
$existing = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $pid5000 = $existing.OwningProcess
    Write-Host "[CabinAI] Killing existing process on port 5000 (PID $pid5000)..." -ForegroundColor Yellow
    Stop-Process -Id $pid5000 -Force -ErrorAction SilentlyContinue
    Start-Sleep 2
}

# Pick best Python — prefer venv312 (has all deps), fall back to arm64 system Python
if (Test-Path $py312venv) {
    $python = $py312venv
    Write-Host "[CabinAI] Using .venv312 Python 3.12" -ForegroundColor Green
} elseif (Test-Path $py312arm) {
    $python = $py312arm
    Write-Host "[CabinAI] Using Python 3.12 ARM64 system" -ForegroundColor Green
} else {
    $python = "python"
    Write-Host "[CabinAI] Using system Python (qai-hub may be unavailable)" -ForegroundColor Yellow
}

# Export models if requested
if ($export) {
    Write-Host "[CabinAI] Running model export..." -ForegroundColor Cyan
    & $python "$root\scripts\export_models.py"
}

# Start backend
Write-Host "[CabinAI] Starting backend on http://localhost:5000" -ForegroundColor Cyan
$backendProc = Start-Process -FilePath $python `
    -ArgumentList "$root\backend\server.py" `
    -WorkingDirectory $root `
    -PassThru -NoNewWindow

if ($frontend) {
    Write-Host "[CabinAI] Starting frontend on http://localhost:3000" -ForegroundColor Cyan
    Start-Sleep 3
    Start-Process -FilePath $npx -ArgumentList "serve","$root\frontend","-p","3000" -WorkingDirectory $root -NoNewWindow
    Start-Sleep 2
    if (Test-Path $edge) {
        Start-Process -FilePath $edge -ArgumentList "http://localhost:3000"
    } else {
        Start-Process "http://localhost:3000"
    }
}

Write-Host "[CabinAI] Backend PID: $($backendProc.Id)" -ForegroundColor Green
Write-Host "[CabinAI] Press Ctrl+C to stop" -ForegroundColor Gray
$backendProc.WaitForExit()

# Export models if requested
if ($export) {
    Write-Host "[CabinAI] Running model export..." -ForegroundColor Cyan
    & $python "$root\scripts\export_models.py"
}

# Start backend
Write-Host "[CabinAI] Starting backend on http://localhost:5000" -ForegroundColor Cyan
$backendProc = Start-Process -FilePath $python `
    -ArgumentList "$root\backend\server.py" `
    -WorkingDirectory $root `
    -PassThru -NoNewWindow

if ($frontend) {
    Write-Host "[CabinAI] Starting frontend on http://localhost:3000" -ForegroundColor Cyan
    Start-Sleep 2
    Start-Process -FilePath $npx -ArgumentList "serve","$root\frontend","-p","3000" -WorkingDirectory $root -NoNewWindow
    Start-Sleep 2
    if (Test-Path $edge) {
        Start-Process -FilePath $edge -ArgumentList "http://localhost:3000"
    } else {
        Start-Process "http://localhost:3000"
    }
}

Write-Host "[CabinAI] Backend PID: $($backendProc.Id)" -ForegroundColor Green
Write-Host "[CabinAI] Press Ctrl+C to stop" -ForegroundColor Gray
$backendProc.WaitForExit()
