# MARUDAM System Documentation

Welcome to the comprehensive, code-derived documentation for the MARUDAM AI Agricultural Monitoring System. 

This documentation package has been forensically extracted from the exact implementation of the Next.js frontend, FastAPI backend, Supabase database schemas, and ESP32 firmware.

> [!IMPORTANT]
> This documentation strictly reflects the *current state of the codebase*, not the theoretical design. Any deviations, missing features, or mocked values (such as pH/EC) are explicitly documented as such.

## Table of Contents

### System Architecture & Data Flow
- [System Architecture](ARCHITECTURE.md)
- [ESP32 Hardware & Sensors](ESP32_AND_SENSORS.md)
- [Sensor Data Pipeline Trace](SENSOR_DATA_PIPELINE.md)
- [Database Schema & Structure](DATABASE.md)
- [API Reference](API_REFERENCE.md)

### Algorithms & Logic
- [Formulas and Calculations](FORMULAS_AND_CALCULATIONS.md)
- [Adaptive Baseline Engine](ADAPTIVE_BASELINE.md)
- [Anomaly Detection](ANOMALY_DETECTION.md)
- [Risk Engine](RISK_ENGINE.md)
- [Recommendation Engine](RECOMMENDATIONS.md)
- [AI & Gemini Integration](AI_GEMINI.md)

### Frontend & User Experience
- [Website Flows & UI](WEBSITE_FLOWS.md)
- [Localization & i18n](LOCALIZATION.md)
- [Frontend Function Inventory](FRONTEND_FUNCTIONS.md)
- [Backend Function Inventory](BACKEND_FUNCTIONS.md)

### Operations & Maintenance
- [Security Architecture](SECURITY.md)
- [Implementation Status](IMPLEMENTATION_STATUS.md)
- [Known Issues & Edge Cases](KNOWN_ISSUES.md)
