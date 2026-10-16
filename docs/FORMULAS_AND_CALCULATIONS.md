# Formulas and Calculations

This document details every mathematical, statistical, and rule-based formula implemented within the MARUDAM system.

## 1. Adaptive Baseline Algorithm

Located in: `backend/app/services/adaptive_baseline_service.py`
Execution: Triggered upon receiving a new sensor reading.

### a. Center Update (Exponential Moving Average)
- **Formula:** $Center_{new} = ( \alpha \times Reading ) + ( (1 - \alpha) \times Center_{old} )$
- **Variables:**
  - $Reading$: The current sensor reading (e.g., $31.4$).
  - $\alpha$: Smoothing factor (`0.1` by default for stability).
- **Fallback:** If `observations < MIN_OBSERVATIONS_FOR_BASE` (10), $Center$ is simply the arithmetic mean of all previous readings.

### b. Mean Absolute Deviation (MAD)
- **Formula:** $MAD_{new} = ( \alpha \times |Reading - Center_{new}| ) + ( (1 - \alpha) \times MAD_{old} )$
- **Purpose:** Tracks the historical volatility of the sensor.

### c. Effective MAD ($MAD_{eff}$)
- **Formula:** $MAD_{eff} = \max(MAD_{current}, MAD_{floor})$
- **Purpose:** Prevents the acceptable variance from shrinking to zero in perfectly stable conditions, which would cause false positive anomalies on minor fluctuations.
- **Floors:** Temp: `0.5`, Humidity: `2.0`, Moisture: `1.0`, Lux: `50.0`.

### d. Expected Range Calculation
- **Formula:** 
  - $Min_{expected} = Center - (K \times MAD_{eff})$
  - $Max_{expected} = Center + (K \times MAD_{eff})$
- **Variables:** $K$ is the sensitivity multiplier (default `3.0`).
- **Example (Air Temp):** If $Center = 30.0$, $MAD = 1.0$, $K = 3.0$: Range is $[27.0, 33.0]$.

## 2. Anomaly Scoring

Located in: `backend/app/services/anomaly_service.py`
Execution: Triggered after baseline updates.

### a. Z-Score (Deviation Score)
- **Formula:** $Z = \frac{|Reading - Center|}{MAD_{eff}}$
- **Classification Thresholds:**
  - $Z > 3.0$: Anomaly detected (severity calculated below)

### b. Severity Calculation
- **Formula:** $Severity = \min(1.0, \frac{Z - 3.0}{5.0})$
- **Meaning:** A $Z$ of `3.0` yields `0.0` severity (just crossed threshold). A $Z$ of `8.0` yields `1.0` (maximum severity).
- **Result:** Classified into levels based on thresholds (e.g., `CRITICAL` if severity > 0.8).

## 3. Dataset pH & EC Aggregation

Located in: `backend/app/services/soil_dataset_service.py`
Execution: Run once on dataset load.

### a. Crop Reference Baseline
- **Formula:** $pH_{ref} = \text{Median}(pH_1, pH_2, \dots, pH_n)$
- **Implementation:** `round(statistics.median(data["ph"]), 2)`
- **Reasoning:** Median is used to resist outliers present in the raw CSV dataset.

## 4. Hardware Conversions (ESP32)

Located in: `esp32/src/main.cpp` (if implemented; currently mocked in test sketch)

### a. Analog Moisture to Percentage
- **Formula:** $Moisture\% = \frac{Voltage - Voltage_{dry}}{Voltage_{wet} - Voltage_{dry}} \times 100$
- **Code:** `map(volts, AIR_VOLTAGE, WATER_VOLTAGE, 0, 100)`
- **Constraint:** Constrained between `0` and `100` to prevent negative percentages if the sensor drifts.

## 5. Confidence Scoring

Located in: `backend/app/services/adaptive_baseline_service.py`

### a. Baseline Confidence
- **Formula:** $Confidence = \min(1.0, \frac{Observations}{100})$
- **Purpose:** Tells the frontend and AI how much to trust the baseline constraints. Reaches `1.0` after 100 readings.

## 6. Weather-Assisted Decision Matrix (INFERRED FROM AI PROMPT)

Located in: `backend/app/services/ai_service.py`
- **Logic:** The AI is explicitly instructed via its prompt to combine the weather forecast with soil moisture anomalies.
- **Rule:** IF (Soil Moisture is LOW) AND (Rain probability > 70%), THEN recommendation = "Delay Irrigation".
- **Status:** This is *AI-derived logic*, not an explicit hardcoded Python mathematical formula.
