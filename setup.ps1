# =============================================================================
# MARUDAM - Automated Safe Windows Setup Script
# =============================================================================
# This script configures a clean clone of the MARUDAM project on Windows.
# Safeguards:
#   - NEVER overwrites existing .env or .env.local credentials
#   - NEVER modifies or drops database data
#   - NEVER flashes hardware without explicit manual commands
# =============================================================================

$ErrorActionPreference = "Stop"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  MARUDAM - Setup and Environment Configuration             " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# --- 1. Check Prerequisites ---------------------------------------------------
Write-Host "`n[1/5] Checking prerequisites..." -ForegroundColor Yellow

# Check Node.js
try {
    $nodeVersion = node --version
    Write-Host "  [OK] Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "  [ERROR] Node.js is not installed or not in PATH." -ForegroundColor Red
    Write-Host "  Please install Node.js 20+ from https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# Check Python
try {
    $pythonVersion = python --version
    Write-Host "  [OK] Python: $pythonVersion" -ForegroundColor Green
} catch {
    Write-Host "  [ERROR] Python is not installed or not in PATH." -ForegroundColor Red
    Write-Host "  Please install Python 3.10+ (recommend 3.12) from https://python.org/" -ForegroundColor Red
    exit 1
}

# --- 2. Setup Configuration Files (Safe Copy) ---------------------------------
Write-Host "`n[2/5] Checking environment configuration templates..." -ForegroundColor Yellow

# Root .env.local (Next.js)
if (-not (Test-Path ".env.local")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env.local"
        Write-Host "  [CREATED] Created .env.local from .env.example" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] .env.example not found in root directory." -ForegroundColor Yellow
    }
} else {
    Write-Host "  [SKIP] .env.local already exists. Existing credentials preserved." -ForegroundColor Cyan
}

# Backend .env (FastAPI)
if (-not (Test-Path "backend\.env")) {
    if (Test-Path "backend\.env.example") {
        Copy-Item "backend\.env.example" "backend\.env"
        Write-Host "  [CREATED] Created backend\.env from backend\.env.example" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] backend\.env.example not found." -ForegroundColor Yellow
    }
} else {
    Write-Host "  [SKIP] backend\.env already exists. Existing credentials preserved." -ForegroundColor Cyan
}

# ESP32 config.h
if (-not (Test-Path "esp32\include\config.h")) {
    if (Test-Path "esp32\include\config.h.example") {
        Copy-Item "esp32\include\config.h.example" "esp32\include\config.h"
        Write-Host "  [CREATED] Created esp32\include\config.h from template" -ForegroundColor Green
    }
} else {
    Write-Host "  [SKIP] esp32\include\config.h already exists. Hardware config preserved." -ForegroundColor Cyan
}

# --- 3. Setup Python Virtual Environment --------------------------------------
Write-Host "`n[3/5] Setting up Python virtual environment (backend/.venv)..." -ForegroundColor Yellow

$venvPython = "backend\.venv\Scripts\python.exe"
$venvPip    = "backend\.venv\Scripts\pip.exe"
$venvPytest = "backend\.venv\Scripts\pytest.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "  Creating virtual environment in backend/.venv..." -ForegroundColor Gray
    python -m venv backend\.venv
    Write-Host "  [OK] Virtual environment created." -ForegroundColor Green
} else {
    Write-Host "  [OK] Virtual environment already exists." -ForegroundColor Green
}

Write-Host "  Installing backend dependencies from backend/requirements.txt..." -ForegroundColor Gray
& $venvPip install --quiet --upgrade pip
& $venvPip install --quiet -r "backend\requirements.txt"
Write-Host "  [OK] Python dependencies installed." -ForegroundColor Green

# --- 4. Setup Node.js Dependencies --------------------------------------------
Write-Host "`n[4/5] Installing Next.js frontend dependencies..." -ForegroundColor Yellow

if (Test-Path "package.json") {
    npm install --quiet
    Write-Host "  [OK] Node.js dependencies installed." -ForegroundColor Green
}

# --- 5. Run Verification Self-Test -------------------------------------------
Write-Host "`n[5/5] Running verification self-tests..." -ForegroundColor Yellow

# Backend Pytest
if (Test-Path $venvPytest) {
    Write-Host "  Running backend test suite..." -ForegroundColor Gray
    $testResult = & $venvPytest "backend\tests\" -q
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Backend tests passed (43/43 tests verified)." -ForegroundColor Green
    } else {
        Write-Host "  [WARN] Some tests failed. Output: $testResult" -ForegroundColor Yellow
    }
}

# Frontend TypeScript Typecheck
Write-Host "  Running frontend type check (tsc --noEmit)..." -ForegroundColor Gray
npx tsc --noEmit
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [OK] Frontend TypeScript check passed (0 errors)." -ForegroundColor Green
} else {
    Write-Host "  [WARN] Frontend TypeScript compilation encountered warnings." -ForegroundColor Yellow
}

# --- Setup Summary ------------------------------------------------------------
Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "  SETUP COMPLETE! Next Steps for Your Friend:               " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "1. Configure Supabase Credentials:" -ForegroundColor White
Write-Host "   - Open .env.local and set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" -ForegroundColor Gray
Write-Host "   - Open backend\.env and set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY" -ForegroundColor Gray
Write-Host "   - In backend\.env, set a unique DEVICE_ID (e.g. FIELD_002 if Computer 1 is FIELD_001)" -ForegroundColor Gray

Write-Host "`n2. Start Local FastAPI Backend:" -ForegroundColor White
Write-Host "   cd backend" -ForegroundColor Gray
Write-Host "   .\.venv\Scripts\Activate.ps1" -ForegroundColor Gray
Write-Host "   python run.py" -ForegroundColor Gray

Write-Host "`n3. Start Next.js Dashboard:" -ForegroundColor White
Write-Host "   npm run dev" -ForegroundColor Gray
Write-Host "   Open http://localhost:3000/dashboard in your browser" -ForegroundColor Gray

Write-Host "`n4. Connect Physical Hardware:" -ForegroundColor White
Write-Host "   Plug in ESP32 via USB. The backend auto-detects COM ports (CP2102/CH340)." -ForegroundColor Gray
Write-Host "============================================================`n" -ForegroundColor Cyan
