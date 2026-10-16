# Known Issues

This document lists all known issues, bugs, and edge cases discovered during the MARUDAM code inspection.

| Issue | Location | Impact | Severity |
| :--- | :--- | :--- | :--- |
| **Missing Cloud Table (`adaptive_baselines`)** | `schema_v3.sql` vs Cloud DB | The backend logs `PGRST205` errors trying to load or save baseline states. The system gracefully falls back to an in-memory dictionary, meaning AI baselines work, but are lost if the backend server restarts. | High |
| **Vercel RLS Blocking** | Supabase Cloud | Vercel fetches return `401 Unauthorized`. Fixed by running `setup_rls.sql` in the Supabase UI. | High |
| **Local API Route Hardcoding** | `src/app/dashboard/page.tsx` | The frontend attempts to poll `http://127.0.0.1:8000/api/sensors/latest/FIELD_001`. This throws CORS or blocked-mixed-content errors when the dashboard is loaded via `https://marudam.vercel.app` on a phone or external network. | Medium |
| **Fake pH/EC Data** | `ESP32 Hardware` | The hardware lacks pH/EC sensors. The data is entirely injected from `soil_dataset.csv`. This means the dashboard implies live physical measurements, which could mislead agronomic decisions. | Medium |
| **Weather/Root-Zone Logic Missing** | `ai_service.py` / `page.tsx` | The UI shows placeholders for Weather and Root-Zone, and the AI prompt references them, but no code actually fetches weather data or mathematically models the root zone. | Low |
| **Test Sketch Output Format** | `ESP32 Firmware` | The current firmware outputs plain text instead of the expected JSON. The backend `serial_manager.py` has a workaround, but it is fragile if the firmware format changes slightly. | Low |
