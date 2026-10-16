# Risk Engine

The Risk Engine evaluates the overall health of the field based on aggregated sensor anomalies, combining them into a single holistic risk score.

Located primarily in inferred logic within backend decision making (e.g. `anomaly_service.py` leading to `/api/decision`).

## 1. Risk Scoring Logic
The system computes an overall risk level based on the count and severity of active anomalies.

- **LOW RISK:** No active anomalies, or only anomalies with severity < 0.2.
- **MEDIUM RISK:** One or more anomalies with severity > 0.2 but < 0.7.
- **HIGH RISK:** Multiple anomalies, or at least one anomaly with severity >= 0.7 (e.g., severe drought or heat stress).
- **CRITICAL RISK:** Critical sensor thresholds breached (e.g., soil moisture falls below permanent wilting point equivalents).

## 2. Recommendation Matrix
The risk engine outputs deterministic recommendations before AI is involved:
- **Low Risk:** "Optimal conditions. Continue standard monitoring."
- **High Temp + Low Moisture:** "High risk of heat stress. Immediate irrigation recommended."
- **Low Temp + High Humidity:** "Fungal disease risk. Reduce irrigation, monitor for blight."

*(Note: AI can override or enrich these rules if `/api/chat` or full AI analysis is invoked).*
