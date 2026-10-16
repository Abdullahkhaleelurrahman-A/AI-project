# Recommendation Engine

The recommendation engine in MARUDAM operates in two distinct tiers: Rule-Based (Deterministic) and AI-Based (Generative).

## 1. Rule-Based Recommendations

Located entirely within the `backend/` logic (prior to `/api/decision` serialization).

These recommendations are hardcoded safety fallbacks that trigger immediately upon event creation.
- **Trigger:** Active anomalies grouped by the Risk Engine.
- **Example Logic:**
  - IF `severity >= 0.8` AND `sensor == 'soil_moisture'` AND `type == 'LOW'`:
    - Recommendation: "CRITICAL: Irrigate immediately to prevent permanent wilting."
  - IF `severity >= 0.8` AND `sensor == 'air_temperature'` AND `type == 'HIGH'`:
    - Recommendation: "CRITICAL: Deploy shade nets if possible. Increase irrigation to mitigate heat stress."
- **Execution:** Instantaneous, deterministic.

## 2. AI-Based Recommendations (Gemini)

Located in `backend/app/services/ai_service.py`.

These recommendations are generated on-demand when the user queries the chatbot. They supersede rule-based logic by factoring in multiple dimensions.

### Context Matrix Supplied to AI:
1. **Current Physical Anomalies** (e.g. Temp is HIGH, Moisture is LOW).
2. **Crop Growth Stage** (e.g. Rice - Tillering Stage).
3. **Location/Climate Zone** (e.g. Tamil Nadu, Coastal Saline).

### Generative Logic:
The AI is instructed to cross-reference the anomaly with the crop stage.
- *Rule-Based output would say:* "Moisture is low, irrigate."
- *AI-Based output says:* "Because your Rice is in the Tillering stage, the low moisture is critical. However, in Tamil Nadu's coastal zone, avoid saline groundwater. Irrigate with 10mm of freshwater immediately."

**Note:** Weather integration was referenced in the prompt design for Gemini ("consider upcoming rain"), but the actual weather API fetch logic is currently **NOT IMPLEMENTED** in the backend codebase.
