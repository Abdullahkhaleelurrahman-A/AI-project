'use client';

import { useState, useEffect } from 'react';

interface HistoricalRecord {
  date: string;
  soil_moisture_avg?: number | null;
  soil_temperature_avg?: number | null;
  air_temperature_avg?: number | null;
  humidity_avg?: number | null;
  readings_count: number;
  data_type: string;
  source: string;
}

interface ForecastDay {
  date: string;
  temp_min: number;
  temp_max: number;
  humidity_avg: number;
  rain_probability_max: number;
  rain_volume_sum: number;
  condition: string;
  description: string;
  icon: string;
  data_type: string;
}

interface ReportData {
  device_id: string;
  generated_at: string;
  window_days: number;
  farm_context: Record<string, any>;
  location: {
    name: string;
    district?: string;
    state?: string;
    country: string;
    latitude: number;
    longitude: number;
  };
  historical_ground_sensors: HistoricalRecord[];
  current_ground_sensor?: Record<string, any> | null;
  current_weather_station: {
    timestamp: string;
    condition: string;
    description: string;
    temperature: number;
    feels_like: number;
    humidity: number;
    pressure: number;
    wind_speed: number;
    clouds: number;
    rain_1h: number;
    data_type: string;
  };
  forecast_outlook: ForecastDay[];
  data_lineage: Record<string, string>;
  agronomic_recommendation: {
    action_code: string;
    text: string;
    total_5day_forecast_rain_mm: number;
    forecast_rainy_days_count: number;
  };
}

interface AgriculturalReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  deviceId: string;
  district?: string;
  state?: string;
  backendUrl?: string;
}

export default function AgriculturalReportModal({
  isOpen,
  onClose,
  deviceId,
  district,
  state,
  backendUrl = 'http://localhost:8000',
}: AgriculturalReportModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    const fetchReport = async () => {
      try {
        const params = new URLSearchParams();
        if (district) params.append('district', district);
        if (state) params.append('state', state);

        const url = `${backendUrl}/api/weather/report/15-day/${encodeURIComponent(deviceId)}?${params.toString()}`;
        const res = await fetch(url);

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData?.detail?.error || `Failed to load report (HTTP ${res.status})`);
        }

        const data = await res.json();
        if (isMounted) {
          setReport(data);
          setLoading(false);
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err.message || 'Failed to generate agricultural report.');
          setLoading(false);
        }
      }
    };

    fetchReport();

    return () => {
      isMounted = false;
    };
  }, [isOpen, deviceId, district, state, backendUrl]);

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 9999,
      background: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(6px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1.5rem',
    }}>
      <div style={{
        background: 'var(--bg-panel, #111a11)',
        border: '1.5px solid var(--border-subtle, rgba(255,255,255,0.15))',
        borderRadius: '1rem',
        width: '100%',
        maxWidth: '920px',
        maxHeight: '90vh',
        overflowY: 'auto',
        boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        color: 'var(--text-primary, #ffffff)',
      }}>
        {/* Modal Header */}
        <div style={{
          padding: '1.25rem 1.5rem',
          borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(255, 255, 255, 0.02)',
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <span style={{ fontSize: '1.25rem' }}>📋</span>
              <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 800 }}>
                15-Day Agricultural Telemetry & Weather Report
              </h2>
            </div>
            <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-muted, #94a3b8)' }}>
              Node: <span style={{ fontFamily: 'monospace', color: 'var(--brand-primary, #4ade80)' }}>{deviceId}</span> • Location: {report?.location.district || district || 'Field Location'}, {report?.location.state || state || 'India'}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted, #94a3b8)',
              fontSize: '1.4rem',
              cursor: 'pointer',
              padding: '0.25rem 0.5rem',
              borderRadius: '0.25rem',
            }}
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {loading && (
            <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: '2rem', marginBottom: '0.5rem', animation: 'spin 1s infinite linear' }}>⏳</div>
              Generating 15-day agricultural report from sensor records & meteorological station...
            </div>
          )}

          {error && (
            <div style={{
              background: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#f87171',
              padding: '1rem',
              borderRadius: '0.5rem',
              fontSize: '0.88rem',
            }}>
              ⚠️ {error}
            </div>
          )}

          {!loading && !error && report && (
            <>
              {/* Agronomic Recommendation Banner */}
              <div style={{
                background: 'linear-gradient(135deg, rgba(42, 110, 31, 0.25), rgba(74, 222, 128, 0.1))',
                border: '1.5px solid rgba(74, 222, 128, 0.35)',
                borderRadius: '0.75rem',
                padding: '1rem 1.25rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                  <span style={{ fontSize: '1.1rem' }}>🌱</span>
                  <span style={{ fontSize: '0.82rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#4ade80' }}>
                    Agronomic Recommendation ({report.agronomic_recommendation.action_code})
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5, color: '#f1f5f9' }}>
                  {report.agronomic_recommendation.text}
                </p>
                <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'rgba(255,255,255,0.7)', display: 'flex', gap: '1rem' }}>
                  <span>🌧️ 5-Day Projected Rain: <strong>{report.agronomic_recommendation.total_5day_forecast_rain_mm.toFixed(1)} mm</strong></span>
                  <span>🗓️ Projected Rainy Days: <strong>{report.agronomic_recommendation.forecast_rainy_days_count}</strong></span>
                </div>
              </div>

              {/* Day 0: Current Ground Telemetry vs Meteorological Station */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <h3 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Day 0: Current Observations
                  </h3>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Real-Time Synchronization</span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
                  {/* Physical ESP32 Ground Measurements */}
                  <div style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(74,222,128,0.25)',
                    borderRadius: '0.75rem',
                    padding: '1rem',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#4ade80' }}>🌱 Ground Soil Sensors</span>
                      <span style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem', borderRadius: '4px', background: 'rgba(74,222,128,0.15)', color: '#4ade80', fontWeight: 600 }}>
                        ESP32 MEASURED
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.82rem' }}>
                      <div>
                        <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.72rem' }}>Soil Moisture</span>
                        <strong style={{ fontSize: '1.05rem' }}>
                          {report.current_ground_sensor?.soil_moisture != null ? `${report.current_ground_sensor.soil_moisture.toFixed(1)}%` : '--'}
                        </strong>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.72rem' }}>Soil Temperature</span>
                        <strong style={{ fontSize: '1.05rem' }}>
                          {report.current_ground_sensor?.soil_temperature != null ? `${report.current_ground_sensor.soil_temperature.toFixed(1)}°C` : '--'}
                        </strong>
                      </div>
                    </div>
                  </div>

                  {/* OpenWeatherMap Station Measurements */}
                  <div style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(56,189,248,0.25)',
                    borderRadius: '0.75rem',
                    padding: '1rem',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                      <span style={{ fontWeight: 700, fontSize: '0.85rem', color: '#38bdf8' }}>📡 Weather Station</span>
                      <span style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem', borderRadius: '4px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8', fontWeight: 600 }}>
                        METEOROLOGICAL OBSERVED
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.5rem', fontSize: '0.82rem' }}>
                      <div>
                        <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.72rem' }}>Condition</span>
                        <strong>{report.current_weather_station.condition}</strong>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.72rem' }}>Air Temp</span>
                        <strong>{report.current_weather_station.temperature}°C</strong>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.72rem' }}>Humidity</span>
                        <strong>{report.current_weather_station.humidity}%</strong>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 5-Day Forward Forecast */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <h3 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Forecast Outlook (Days +1 to +5)
                    </h3>
                    <span style={{ fontSize: '0.68rem', padding: '0.12rem 0.4rem', borderRadius: '4px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8', fontWeight: 600 }}>
                      OPENWEATHERMAP 5-DAY PROJECTION
                    </span>
                  </div>
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', textAlign: 'left', color: 'var(--text-muted)' }}>
                        <th style={{ padding: '0.5rem' }}>Date</th>
                        <th style={{ padding: '0.5rem' }}>Condition</th>
                        <th style={{ padding: '0.5rem' }}>Temp (Min / Max)</th>
                        <th style={{ padding: '0.5rem' }}>Avg Humidity</th>
                        <th style={{ padding: '0.5rem' }}>Rain Probability</th>
                        <th style={{ padding: '0.5rem' }}>Rain Volume</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.forecast_outlook.map((f, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <td style={{ padding: '0.5rem', fontWeight: 600 }}>{f.date}</td>
                          <td style={{ padding: '0.5rem' }}>{f.condition} ({f.description})</td>
                          <td style={{ padding: '0.5rem' }}>{f.temp_min}°C – {f.temp_max}°C</td>
                          <td style={{ padding: '0.5rem' }}>{f.humidity_avg}%</td>
                          <td style={{ padding: '0.5rem', color: f.rain_probability_max > 50 ? '#38bdf8' : 'inherit', fontWeight: f.rain_probability_max > 50 ? 700 : 400 }}>
                            {f.rain_probability_max}%
                          </td>
                          <td style={{ padding: '0.5rem' }}>{f.rain_volume_sum > 0 ? `${f.rain_volume_sum} mm` : '--'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Historical Sensor Telemetry (Days -10 to -1) */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <h3 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Historical Ground Sensor Telemetry (Past 10 Days)
                    </h3>
                    <span style={{ fontSize: '0.68rem', padding: '0.12rem 0.4rem', borderRadius: '4px', background: 'rgba(74,222,128,0.15)', color: '#4ade80', fontWeight: 600 }}>
                      PHYSICAL SENSOR RECORDS
                    </span>
                  </div>
                </div>

                {report.historical_ground_sensors.length === 0 ? (
                  <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    No historical logs recorded in Supabase for this device within the past 10 days yet.
                  </p>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.1))', textAlign: 'left', color: 'var(--text-muted)' }}>
                          <th style={{ padding: '0.5rem' }}>Date</th>
                          <th style={{ padding: '0.5rem' }}>Avg Soil Moisture</th>
                          <th style={{ padding: '0.5rem' }}>Avg Soil Temp</th>
                          <th style={{ padding: '0.5rem' }}>Avg Air Temp</th>
                          <th style={{ padding: '0.5rem' }}>Log Count</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.historical_ground_sensors.map((h, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            <td style={{ padding: '0.5rem', fontWeight: 600 }}>{h.date}</td>
                            <td style={{ padding: '0.5rem' }}>{h.soil_moisture_avg != null ? `${h.soil_moisture_avg}%` : '--'}</td>
                            <td style={{ padding: '0.5rem' }}>{h.soil_temperature_avg != null ? `${h.soil_temperature_avg}°C` : '--'}</td>
                            <td style={{ padding: '0.5rem' }}>{h.air_temperature_avg != null ? `${h.air_temperature_avg}°C` : '--'}</td>
                            <td style={{ padding: '0.5rem' }}>{h.readings_count} packets</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Data Integrity & Limitation Notice */}
              <div style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '0.5rem',
                padding: '0.75rem 1rem',
                fontSize: '0.74rem',
                color: 'var(--text-muted)',
                lineHeight: 1.5,
              }}>
                ℹ️ <strong>Scientific Integrity Notice:</strong> Historical records represent physical measurements logged by your ESP32 node. Forecasts are strictly limited to the provider&apos;s 5-day horizon (40 slices). Historical weather is not backfilled or invented.
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div style={{
          padding: '1rem 1.5rem',
          borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.75rem',
        }}>
          <button
            onClick={onClose}
            style={{
              background: 'var(--brand-primary, #2a6e1f)',
              color: '#ffffff',
              border: 'none',
              borderRadius: '0.5rem',
              padding: '0.5rem 1.25rem',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Close Report
          </button>
        </div>
      </div>
    </div>
  );
}
