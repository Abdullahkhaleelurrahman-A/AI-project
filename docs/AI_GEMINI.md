# AI & Gemini System Architecture

MARUDAM incorporates Google's Gemini AI to interpret agricultural anomalies and provide contextualized recommendations.

Located in: `backend/app/services/ai_service.py`

## 1. Rule-Based vs AI-Derived Distinction

**CRITICAL UNDERSTANDING:**
Gemini does **NOT** detect anomalies. Gemini does **NOT** read raw serial streams to decide if the temperature is too high.
The rule-based Python backend (`adaptive_baseline_service.py` & `anomaly_service.py`) handles all mathematical thresholds and event creation. 
Gemini is strictly used for **post-event analysis** and **recommendation generation**.

## 2. Trigger Conditions
Gemini is invoked when:
1. The frontend explicitly requests AI analysis via the Chat interface (`/api/chat`).
2. The risk engine aggregates active anomalies and decides they warrant a complex text explanation.
3. The farmer clicks the "Ask Marudam" FAB on the dashboard and asks a direct question.

## 3. Contextual Data Injection
When an AI prompt is generated, the backend gathers massive amounts of context to ensure the LLM's response is hyper-localized:

- **Location Data:** Indian State, District, and Climate Zone (via `india_context_service.py`).
- **Crop Data:** The specific crop currently planted on that device's field (e.g., Rice, Seedling stage).
- **Current Readings:** The latest `SensorReading` packet.
- **Active Anomalies:** All currently `ACTIVE` anomalies from the database.
- **Adaptive Baselines:** The current accepted baseline range for the sensors.

## 4. Prompt Construction & System Instructions
The system prompt strictly instructs Gemini to act as "Marudam, an expert AI agricultural assistant in India."
It mandates that Gemini must base its recommendations purely on the provided context block, rather than hallucinating external conditions.

## 5. Fallback Behavior
- **Missing API Key:** If `GEMINI_API_KEY` is not present in `.env`, `ai_service.py` safely logs a warning and returns fallback hardcoded recommendations (e.g., "AI Unavailable: Inspect irrigation system manually").
- **API Timeout/Error:** Wrapped in try/except blocks to return safe fallback JSON.

## 6. Frontend Chat Interface
- **Component:** `MarudamChat.tsx`
- **Behavior:** The frontend sends user queries to the backend. The backend enriches the query with the farm's telemetry context *before* sending it to Gemini, ensuring the chat is always context-aware without the frontend needing to assemble the payload.
