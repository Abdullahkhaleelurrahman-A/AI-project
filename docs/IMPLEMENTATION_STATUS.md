# Implementation Status

Current feature status of the MARUDAM system.

| Feature | Status | Evidence | Notes |
| :--- | :--- | :--- | :--- |
| **ESP32 Serial Ingestion** | IMPLEMENTED | `serial_manager.py` | Automatically detects COM ports and parses both JSON and human-readable text fallbacks. |
| **Physical Sensors (Temp/Hum/Lux/Moisture)** | IMPLEMENTED | `main.cpp`, `sensor_service.py` | Readings map correctly to Pydantic models and Supabase. |
| **pH/EC Readings** | PARTIALLY IMPLEMENTED | `soil_dataset_service.py` | Implemented purely as a dataset lookup based on crop. There are no physical pH/EC sensors attached to the ESP32. |
| **Supabase Database Persistence** | IMPLEMENTED | `supabase_service.py` | Service role key successfully inserts readings and events. |
| **Adaptive Baselines** | PARTIALLY IMPLEMENTED | `adaptive_baseline_service.py` | Algorithm is fully mathematically implemented, but the cloud database table `adaptive_baselines` was missing, causing it to run in-memory only. |
| **Anomaly Detection** | IMPLEMENTED | `anomaly_service.py` | Successfully creates and tracks stateful events based on Baseline bounds. |
| **Risk Engine** | IMPLEMENTED | `/api/decision` route | Aggregates anomalies into holistic field risk scores. |
| **AI (Gemini) Integration** | IMPLEMENTED | `ai_service.py` | Invoked on-demand for Chat and complex event explanation. Properly injected with India context. |
| **Dashboard UI** | IMPLEMENTED | `src/app/dashboard/page.tsx` | Next.js layout fully renders sensor widgets, active events, and real-time Supabase updates. |
| **Vercel Cloud Deployment** | IMPLEMENTED | `marudam.vercel.app` | Requires the `setup_rls.sql` script to grant public read access. |
| **Localization (22 Languages)** | IMPLEMENTED | `src/lib/i18n/locales/` | Complete key coverage using Gemini-generated translations and RTL support. |
| **Weather Logic** | NOT IMPLEMENTED | - | Reference to weather exists in AI prompts, but no Open-Meteo API integration was found in the codebase. |
| **Root-zone Logic** | NOT IMPLEMENTED | - | Referenced in UI "Waiting for sufficient data to estimate root zone", but no mathematical estimation logic exists in the backend. |
