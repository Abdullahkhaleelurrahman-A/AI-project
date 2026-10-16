# Website Flows

## 1. Dashboard Loading Flow

1. **User Action:** Navigates to `/dashboard`.
2. **Component (`page.tsx`):** `DashboardPage` mounts.
3. **Authentication Check:** Supabase SSR Client verifies the active session. If logged out, may redirect to `/login`.
4. **Profile Fetch:** Queries `users` table for the authenticated user's associated `device_id` (defaults to `FIELD_001` if missing).
5. **Initial Data Fetch:**
   - Calls `fetchLatestReading("FIELD_001")` (Hits `sensor_readings`).
   - Calls `fetchRecentAnomalies("FIELD_001")`.
   - Calls `fetchDeviceStatus("FIELD_001")`.
6. **Real-time Subscription:**
   - Registers listeners using Supabase Realtime Channels for inserts on `sensor_readings` and `anomalies`.
7. **Fallback Polling:**
   - Initiates a `setInterval` loop to call `http://localhost:8000/api/sensors/latest/FIELD_001`. (This provides robust local-network support if the cloud is down, but fails silently in Vercel production).
8. **UI Render:** 
   - Sensor cards map the `SensorData` state to color-coded widgets.
   - `null` values are rendered as `--`.
   - If no data has been received recently, a "Waiting for ESP32" overlay blurs the dashboard.

## 2. Gemini AI Chat Flow

1. **User Action:** Clicks "Ask Marudam" FAB on the dashboard and types a question.
2. **Component (`MarudamChat.tsx`):** Adds the user message to the local UI state as a "user" bubble.
3. **API Call:** Sends `POST /api/chat` with `{ message: "...", device_id: "FIELD_001" }`.
4. **Backend Route (`main.py`):** Passes the request to `ai_service.py`.
5. **Context Aggregation (`ai_service.py`):**
   - Fetches the latest row from `sensor_readings`.
   - Fetches active events from `anomalies`.
   - Fetches India geographic context from `india_context_service.py`.
6. **Gemini Execution:** Calls the `google-generativeai` SDK with the system prompt + context + user message.
7. **Response Parsing:** Receives markdown text from Gemini.
8. **UI Render:** The chat component appends the response as an "ai" bubble and parses the Markdown into HTML.
