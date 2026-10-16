# Frontend Function Inventory

## Core Pages

### `src/app/dashboard/page.tsx` (`DashboardPage`)
- **Purpose:** Main view for live sensor data, events, and AI chat.
- **State Modified:** `deviceStatus`, `sensorData`, `events`, `baselines`, `error`, `isLoading`.
- **API Calls:** 
  - `fetchLatestReading` (Supabase)
  - `fetchRecentAnomalies` (Supabase)
  - `fetchBackend` (Local `/api/sensors/latest/{deviceId}`)
- **Dependencies:** React hooks (`useEffect`, `useState`), Supabase SSR.
- **Side Effects:** Subscribes to Supabase realtime channels. Sets up polling intervals.

### `src/app/settings/page.tsx`
- **Purpose:** Configuration page for Farm, Crop, and Language.
- **State Modified:** `language`, `cropId`.
- **API Calls:** Updates `farms` table in Supabase.

## Core Components

### `SensorsClient.tsx`
- **Purpose:** Renders the grid of Sensor Cards.
- **Inputs:** `data` (SensorReading object), `baselines` (AdaptiveBaseline mapping).
- **Outputs:** Renders JSX Cards.
- **Dependencies:** `lucide-react` icons.

### `MarudamChat.tsx`
- **Purpose:** Floating Action Button (FAB) and modal for the AI assistant.
- **State Modified:** `messages` (array of chat history), `isOpen`, `isLoading`.
- **API Calls:** `POST /api/chat`.
- **Dependencies:** `framer-motion` for animations.

## Utilities

### `src/lib/supabase/sensors.ts` -> `fetchLatestReading`
- **Purpose:** Retrieves the single most recent row for a device.
- **Inputs:** `deviceId` (string).
- **Outputs:** `SensorReading | null`.
- **API Calls:** Supabase RPC/REST `select('*').eq('device_id', deviceId).order('timestamp', { ascending: false }).limit(1).single()`.
