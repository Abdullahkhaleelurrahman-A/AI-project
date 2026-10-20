# MARUDAM — Smart Soil & Plant Monitoring System

MARUDAM is an AI-powered agricultural monitoring system designed for Indian farmers. It uses a physical ESP32 sensor node connected to a laptop via USB, streams real-time sensor data through a local FastAPI backend, stores everything in Supabase, and presents a multilingual dashboard on the web.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    HARDWARE (LOCAL)                          │
│                                                              │
│  Sensors ──→ ESP32 ──→ Micro-USB ──→ Laptop                 │
│               │                         │                    │
│  (DS18B20,    │                    FastAPI Backend           │
│   DHT22,      │   JSON Lines            │                    │
│   BH1750,     │   @ 115200 baud         │                    │
│   Capacitive) │                         ↓                    │
│                                    Supabase (Cloud DB)       │
└──────────────────────────────────────────────────────────────┘
                                          │
                                          │ Realtime / REST
                                          ↓
┌──────────────────────────────────────────────────────────────┐
│                    CLOUD (VERCEL)                            │
│                                                              │
│  Next.js Dashboard ←─── Supabase Realtime                   │
│  (multilingual, AI chatbot, anomaly alerts)                  │
└──────────────────────────────────────────────────────────────┘
```

> **Critical**: Vercel **cannot** access COM6/COM7/USB ports. The ESP32 → FastAPI path is entirely local. The cloud path is Supabase ↔ Vercel.

---

## Project Structure

```
crop-monitor/                    ← Next.js application root
├── src/
│   ├── app/                     ← Next.js pages (App Router)
│   │   ├── page.tsx             ← Landing page
│   │   ├── dashboard/           ← Main sensor dashboard
│   │   ├── login/               ← Supabase authentication
│   │   ├── register/
│   │   ├── settings/
│   │   ├── help/
│   │   └── api/chat/            ← Gemini chatbot API route
│   ├── components/              ← React components
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts        ← Browser Supabase client
│   │   │   ├── server.ts        ← Server-side Supabase client
│   │   │   ├── sensors.ts       ← Sensor query & Realtime utilities
│   │   │   ├── schema.sql       ← Existing schema (auth, profiles, farms)
│   │   │   └── schema_v2.sql    ← NEW: sensor/device/anomaly tables
│   │   ├── data/db.ts           ← Crop data & location lookup
│   │   ├── i18n/translations.ts ← EN/Hindi/Tamil/Telugu/Kannada
│   │   └── baseline/scheduler.ts
│   └── proxy.ts                 ← Next.js 16 session proxy
├── backend/
│   ├── app/                     ← New modular FastAPI backend
│   │   ├── main.py              ← FastAPI app factory
│   │   ├── config.py            ← Pydantic settings
│   │   ├── models/              ← Pydantic data models
│   │   ├── services/
│   │   │   ├── serial_manager.py   ← USB serial port detection & reader
│   │   │   ├── sensor_service.py   ← Data normalisation
│   │   │   ├── supabase_service.py ← Supabase writes
│   │   │   ├── device_service.py   ← Device status tracking
│   │   │   └── anomaly_service.py  ← Adaptive baseline + anomaly detection
│   │   ├── api/                    ← FastAPI routers
│   │   └── utils/logger.py
│   ├── legacy/main.py           ← PRESERVED original SQLite backend
│   ├── tests/                   ← Pytest tests
│   ├── requirements.txt
│   ├── .env.example
│   └── run.py                   ← Entry point: python run.py
├── esp32/
│   ├── include/config.h         ← Device config (gitignored)
│   └── src/
│       ├── main.cpp             ← Firmware (SERIAL mode default)
│       └── sensors.h           ← Sensor drivers
├── .env.local                   ← Frontend env (gitignored)
├── .env.local.example           ← Frontend env template
└── README.md
```

---

## Supported Sensors

| Sensor | Measurement | Interface | GPIO |
|--------|------------|-----------|------|
| Capacitive Moisture v1.2 | Soil Moisture (%) | ADC | GPIO 34 |
| DS18B20 (waterproof) | Soil Temperature (°C) | OneWire | GPIO 4 |
| DHT22 / AM2302 | Air Temperature + Humidity | Digital | GPIO 27 |
| BH1750 | Light Intensity (lux) | I2C | SDA/SCL |
| *(future)* pH sensor | Soil pH | Analog | — |
| *(future)* EC sensor | Soil EC (dS/m) | Analog | — |

---

## ESP32 JSON Protocol

The ESP32 outputs one JSON object per line over USB serial at 115200 baud:

```json
{
  "device_id": "MARUDAM-01",
  "timestamp": null,
  "soil_moisture": 62.4,
  "soil_temperature": 28.5,
  "soil_ph": null,
  "soil_ec": null,
  "air_temperature": 32.1,
  "humidity": 67.2,
  "light_lux": 450.0,
  "sensor_status": {
    "soil_moisture": "ok",
    "soil_temperature": "ok",
    "soil_ph": "unavailable",
    "soil_ec": "unavailable",
    "air_temperature": "ok",
    "humidity": "ok",
    "light_lux": "ok"
  }
}
```

- `timestamp` is always `null` — the FastAPI backend applies a server-side UTC timestamp.
- Unavailable sensors are `null` with status `"unavailable"`. Failed sensors are `null` with `"error"`.
- Startup diagnostic banners are printed once and ignored by the parser.

---

---

## Quick Start — Automated Setup (Windows)

For a fresh clone on a Windows machine with Node.js and Python installed:

```powershell
# Run the automated pre-flight setup script from the repository root:
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The script safely validates prerequisites (Node.js v18+, Python 3.10-3.12, PlatformIO), creates `.venv`, installs backend pip dependencies, installs frontend npm packages, generates initial `.env` files from `.env.example` templates if missing (never overwrites existing credentials), runs backend unit tests, and verifies TypeScript types.

---

## Multi-Computer Replication Guide (Clean Windows Clone)

Follow this guide to run MARUDAM on a second computer with identical ESP32 hardware and dual-field sensors.

### 1. Prerequisites Checklist

Install the following on the target Windows computer:
- **Node.js**: v18+ or v20+ LTS (verified working up to v24). [Download](https://nodejs.org/)
- **Python**: 3.10, 3.11, or 3.12 (check "Add Python to PATH" during installation). [Download](https://www.python.org/)
- **Git for Windows**: [Download](https://git-scm.com/)
- **USB Serial Driver**: CP210x or CH340 driver (depending on the ESP32 board).
- *(Optional for firmware)* **PlatformIO Core (CLI)** or **VS Code with PlatformIO IDE extension** / **Arduino IDE 2.x**.

---

### 2. Differences Between Computer 1 and Computer 2

| Setting | Computer 1 (Primary) | Computer 2 (Friend) | Why It Matters |
|---|---|---|---|
| **`DEVICE_ID`** | `FIELD_001` (or `MARUDAM-01`) | **`FIELD_002`** (or unique ID) | **CRITICAL:** If both machines use `FIELD_001`, their sensor readings, device status, and adaptive baselines will collide and corrupt the statistical models in Supabase. |
| **`SERIAL_PORT`** | Auto-detected (e.g. `COM6`) | Auto-detected (e.g. `COM3` / `COM4`) | USB port numbers depend on the physical USB socket and driver assigned by Windows Device Manager. Leave as `AUTO` or set your port. |
| **DS18B20 Probes** | Hardware addresses `28E00BBA000000CD`, `286307B3000000CC` | Unique 64-bit addresses on Friend's probes | Dallas probes have factory-unique addresses. The firmware and Arduino test sketch automatically discover them on GPIO 4. |
| **Soil Calibration** | Node 1 calibration values | Node 2 probe analog values | Slight variations in analog capacitance (e.g., dry ~20000, wet ~10500 on ADS1115). Can calibrate in `config.h`. |
| **Farm Profile** | Points to `FIELD_001` | Points to `FIELD_002` in `farms` table | Ensures dashboard displays the friend's field telemetry. |

---

### 3. Supabase Database Configuration

You have two choices for the database:

#### Option A: Shared Cloud Database (Recommended for Pair Monitoring)
If your friend is joining your existing MARUDAM project:
1. Obtain the **`SUPABASE_URL`**, **`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`**, and **`SUPABASE_SERVICE_ROLE_KEY`** securely from the project owner (never commit or send over public chat).
2. Set **`DEVICE_ID=FIELD_002`** in your `backend/.env`.
3. The backend automatically registers `FIELD_002` into the `devices` table on its first connection.
4. In the web dashboard (`http://localhost:3000/settings` or Supabase dashboard), register a farm with `device_id = 'FIELD_002'` so the UI filters to your node.

#### Option B: Dedicated New Supabase Project (Independent Setup)
1. Create a free project at [supabase.com](https://supabase.com).
2. Go to **SQL Editor > New Query** and execute the migration files **in this exact order**:
   - `src/lib/supabase/schema.sql` — User profiles, farms, and base auth
   - `src/lib/supabase/schema_v2.sql` — Sensor readings, devices, anomalies, and device events
   - `src/lib/supabase/schema_v3.sql` — Adaptive baselines engine
   - `src/lib/supabase/schema_v4_two_field.sql` — Multi-field isolation, ADS1115 raw counts/voltage, and composite constraints
3. Enable Realtime on the tables:
   ```sql
   ALTER PUBLICATION supabase_realtime ADD TABLE public.sensor_readings, public.anomalies, public.devices;
   ```
4. Copy your API keys from **Project Settings > API**:
   - `Project URL` → `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `service_role` (secret) → `SUPABASE_SERVICE_ROLE_KEY` (in `backend/.env` only!)

---

### 4. Step-by-Step Manual Installation

#### Step 4.1: Clone and Configure Environment Files
```powershell
cd D:\AI_Project
git clone <repository-url> crop-monitor
cd crop-monitor

# Create environment files from templates
copy .env.example .env.local
copy backend\.env.example backend\.env
copy esp32\include\config.h.example esp32\include\config.h
```

Edit `.env.local` (Frontend):
```ini
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOi...
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
GEMINI_API_KEY=               # Optional: for AI chatbot
```

Edit `backend/.env` (Backend):
```ini
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
DEVICE_ID=FIELD_002           # Unique ID for this machine's ESP32!
SERIAL_PORT=AUTO              # AUTO or explicit COM port (e.g. COM3)
SERIAL_BAUD=115200
MOCK_SERIAL=false
LOG_LEVEL=INFO
```

#### Step 4.2: Install Python Dependencies & Test Backend
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt

# Run verification test suite
pytest tests/ -v
cd ..
```

#### Step 4.3: Install Frontend Dependencies & Verify Types
```powershell
npm install
npx tsc --noEmit
```

---

### 5. ESP32 Hardware & Firmware Setup

The system supports two agricultural fields on a single ESP32:
- **I2C Bus (SDA: GPIO 21, SCL: GPIO 22)**:
  - ADS1115 ADC (address `0x48`): A0 = Field 1 Soil Moisture, A1 = Field 2 Soil Moisture.
  - BH1750 Light Sensor (address `0x23` or `0x5C`).
- **OneWire Bus (GPIO 4)**:
  - DS18B20 Soil Temperature Probes (Probe 0 = Field 1, Probe 1 = Field 2).
- **Digital GPIO 27**:
  - DHT22 (Air Temperature & Ambient Humidity).

#### Firmware Option 1: PlatformIO (Recommended)
```powershell
cd esp32
pio run -t upload
```
To monitor serial output:
```powershell
pio device monitor --baud 115200
```

#### Firmware Option 2: Arduino IDE Test Sketch
If you tested your hardware with the Arduino IDE test sketch that outputs:
```
Field 1: Moisture: 58.4% (Raw: 14210, 1.77V), Temp: 27.8 C
Field 2: Moisture: 61.2% (Raw: 13850, 1.73V), Temp: 28.1 C
DHT22: 31.5 C, 64.0 % | Light: 480 lx
```
The FastAPI backend's **dual-mode serial parser** natively detects and parses this plain-text format as well as the JSON lines format! You can keep running your working test sketch directly.

---

### 6. Starting and Stopping the System

Open two PowerShell windows:

#### Terminal 1 — FastAPI Ingestion Backend:
```powershell
cd D:\AI_Project\crop-monitor\backend
.\.venv\Scripts\Activate.ps1
python run.py
```
*Expected log:*
```
[INFO] serial_manager — Scanning serial ports...
[INFO] serial_manager — ESP32 auto-detected on COMx
[INFO] serial_manager — Serial connection established on COMx @ 115200 baud
[INFO] supabase_service — Sensor reading stored for FIELD_002 (field_1)
[INFO] supabase_service — Sensor reading stored for FIELD_002 (field_2)
```
*To stop:* Press `Ctrl + C`.

#### Terminal 2 — Next.js Web Dashboard:
```powershell
cd D:\AI_Project\crop-monitor
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).
*To stop:* Press `Ctrl + C`.

---

### 7. End-to-End Verification Checklist

Run this checklist to confirm both field readings reach the database and update the dashboard:

- [ ] **COM Port Detected**: Backend logs show `ESP32 auto-detected on COMx` and `Serial connection established`.
- [ ] **Dual Field Packets Parsed**: Backend logs show incoming packets with both `field_1` and `field_2` measurements.
- [ ] **Database Upsert Succeeded**: Backend logs display `Sensor reading stored for <DEVICE_ID> (field_1)` and `(field_2)`.
- [ ] **Supabase Records Query**: In Supabase SQL Editor, verify both fields are present:
  ```sql
  SELECT field_id, COUNT(*), MAX(timestamp) 
  FROM public.sensor_readings 
  WHERE device_id = 'FIELD_002' 
  GROUP BY field_id;
  ```
  *(Both `field_1` and `field_2` should show row counts > 0).*
- [ ] **Local API Verification**: Open `http://localhost:8000/sensor/latest` in your browser. Verify it returns readings for both fields.
- [ ] **Dashboard Verification**: Open `http://localhost:3000/dashboard`.
  - Toggle between Field 1 and Field 2 using the field selector tabs.
  - Verify neither field displays `--` or `Awaiting data`.
  - Verify moisture, temperature, humidity, and light update in real time.

---

### 8. Troubleshooting Guide

#### 1. Missing or Busy COM Port
- **Symptom:** `[WARNING] ESP32 not detected on any COM port` or `Access Denied / PermissionError`.
- **Solution:** 
  1. Close Arduino IDE Serial Monitor or PlatformIO monitor — only one application can hold a COM port at a time.
  2. Unplug and replug the USB cable. Verify you are using a **data cable**, not a charge-only cable.
  3. Check Windows Device Manager under "Ports (COM & LPT)" for `Silicon Labs CP210x` or `USB-SERIAL CH340`.
  4. If your port is known (e.g. `COM4`), override it in `backend/.env`: `SERIAL_PORT=COM4`.

#### 2. Missing Python / Pip Build Tools
- **Symptom:** `error: Microsoft Visual C++ 14.0 or greater is required`.
- **Solution:** `requirements.txt` specifies pre-built wheel versions (`pydantic`, `fastapi`, `pyserial`). Make sure you are using Python 3.10-3.12 (64-bit).

#### 3. Supabase RLS / PGRST Errors
- **Symptom:** Backend logs `[ERROR] supabase_service — PostgREST error: new row violates row-level security policy` or `relation "sensor_readings" does not exist`.
- **Solution:** 
  1. Ensure you used the `SUPABASE_SERVICE_ROLE_KEY` (not the public anon key) in `backend/.env`. The backend requires the service-role key to write to sensor tables.
  2. Verify all 4 migrations (`schema.sql` through `schema_v4_two_field.sql`) were executed.

#### 4. Stale or Missing Field 2 Readings on Dashboard
- **Symptom:** Field 1 updates, but Field 2 shows `--` or `No reading`.
- **Solution:**
  1. Check ADS1115 wiring: A0 goes to Field 1 moisture sensor; A1 goes to Field 2 moisture sensor.
  2. Check DS18B20 OneWire bus: Verify both temperature probes share GPIO 4 with a 4.7kΩ pull-up resistor.
  3. In `esp32/include/config.h`, if static probe addresses don't match your physical probes, the firmware auto-discovers probes 0 and 1. Verify `pio device monitor` outputs temperatures for both probes.

#### 5. Dashboard Displays "Offline" or "Awaiting Data"
- **Symptom:** Frontend cannot reach backend or Supabase.
- **Solution:**
  1. Confirm FastAPI is running on `http://localhost:8000` (`http://localhost:8000/health` returns `{"status":"ok"}`).
  2. Check `.env.local` contains valid `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
  3. Restart Next.js dev server (`npm run dev`) after changing `.env.local`.

---

## Running Tests

```powershell
# Backend unit & integration tests
cd backend
.\.venv\Scripts\Activate.ps1
pytest tests/ -v

# Frontend TypeScript verification
cd ..
npx tsc --noEmit
```

---

## AI / Anomaly Detection

The anomaly service (`backend/app/services/anomaly_service.py`) uses:
- **Adaptive baseline** with robust statistics (Median + Median Absolute Deviation) and exponential smoothing (α = 0.05).
- **Two-field isolation**: Baselines and anomaly scoring are calculated independently for `field_1` and `field_2`.
- **Persistence tracking** — risk escalates over consecutive out-of-range readings.
- **Multi-sensor evidence fusion** — low moisture + high temperature + low humidity = water stress.
- **Configurable thresholds** via environment variables.

Risk levels: `NORMAL` → `LOW` → `MEDIUM` → `HIGH` → `CRITICAL`

**Modular design**: The `detect()` function has a clean interface. AI teammates can replace the algorithm by implementing the same function signature.
