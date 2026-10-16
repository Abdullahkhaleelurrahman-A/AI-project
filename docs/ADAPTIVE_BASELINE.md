# Adaptive Baseline Architecture

The Adaptive Baseline system replaces hardcoded minimum/maximum thresholds (e.g., "Alert if temperature > 35°C") with dynamically learning thresholds tailored to the specific microclimate of the field.

Located in: `backend/app/services/adaptive_baseline_service.py`

## 1. Initialization and Historical Data
When a new device connects, there is no baseline. 
1. The backend queries `adaptive_baselines` from Supabase.
2. If none exist (or the query fails), it initializes a blank state in memory.
3. The first `MIN_OBSERVATIONS_FOR_BASE` (default 10) readings are simply averaged. During this "Learning Phase", the baseline status is `LEARNING` and anomalies are suppressed or flagged with low confidence.

## 2. Statistical Components
- **Center:** The expected value (moving average).
- **MAD (Mean Absolute Deviation):** How much the sensor naturally fluctuates.
- **MAD_eff:** A floored version of MAD to prevent the accepted range from becoming artificially tight during stable periods.
- **K Multiplier:** Defines the width of the acceptable band. Default `3.0`.

## 3. Storage and Persistence
The baseline state is updated in memory with every reading.
To reduce database load, the state is persisted to the Supabase `adaptive_baselines` table periodically (not on every reading).
- **Database Table:** `adaptive_baselines` (NOTE: This table was missing from the cloud deployment initially, causing the system to rely purely on in-memory tracking until restarted).

## 4. Fallback Behavior
If the database table is missing or fails to load (`PGRST205`), the backend logs an error but creates an isolated in-memory baseline dictionary. The system continues to function perfectly for the lifespan of the backend process, but resets if the backend is restarted.
