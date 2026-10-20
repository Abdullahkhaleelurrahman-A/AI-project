'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import AgriculturalReportModal from './AgriculturalReportModal';

interface CurrentWeather {
  timestamp: string;
  condition: string;
  description: string;
  icon: string;
  temperature: number;
  feels_like: number;
  temp_min: number;
  temp_max: number;
  humidity: number;
  pressure: number;
  wind_speed: number;
  wind_deg?: number;
  clouds: number;
  rain_1h: number;
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
}

interface WeatherWidgetProps {
  deviceId: string;
  district?: string;
  state?: string;
  backendUrl?: string;
}

export default function WeatherWidget({
  deviceId,
  district,
  state,
  backendUrl = 'http://localhost:8000',
}: WeatherWidgetProps) {
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<CurrentWeather | null>(null);
  const [forecastDays, setForecastDays] = useState<ForecastDay[]>([]);
  const [locationName, setLocationName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [needsConfig, setNeedsConfig] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);

  const fetchWeatherData = useCallback(async () => {
    // If neither district nor state is available, prompt for configuration
    if (!district && !state) {
      setNeedsConfig(true);
      setError('Farm location is not configured. Please set your farm location in Farm Profile to view meteorological data.');
      setLoading(false);
      return;
    }

    try {
      const params = new URLSearchParams();
      if (deviceId) params.append('device_id', deviceId);
      if (district) params.append('district', district);
      if (state) params.append('state', state);

      const [curRes, fcRes] = await Promise.all([
        fetch(`${backendUrl}/api/weather/current?${params.toString()}`),
        fetch(`${backendUrl}/api/weather/forecast?${params.toString()}`),
      ]);

      if (!curRes.ok) {
        const errJson = await curRes.json().catch(() => ({}));
        if (errJson?.detail?.requires_configuration) {
          setNeedsConfig(true);
          setError(errJson.detail.error);
          setLoading(false);
          return;
        }
        throw new Error(errJson?.detail?.error || `Weather fetch failed (${curRes.status})`);
      }

      const curData = await curRes.json();
      setCurrent(curData.current);
      setLocationName(curData.location?.name || district || 'Farm Location');
      setNeedsConfig(false);
      setError(null);

      if (fcRes.ok) {
        const fcData = await fcRes.json();
        setForecastDays(fcData.forecast_days || []);
      }
    } catch (err: any) {
      setError(err.message || 'Unable to reach weather service.');
    } finally {
      setLoading(false);
    }
  }, [deviceId, district, state, backendUrl]);

  useEffect(() => {
    fetchWeatherData();
    // Refresh weather every 10 minutes
    const interval = setInterval(fetchWeatherData, 600000);
    return () => clearInterval(interval);
  }, [fetchWeatherData]);

  const getWeatherEmoji = (condition: string): string => {
    switch (condition?.toLowerCase()) {
      case 'clear': return '☀️';
      case 'clouds': return '☁️';
      case 'rain': return '🌧️';
      case 'drizzle': return '🌦️';
      case 'thunderstorm': return '⛈️';
      case 'snow': return '❄️';
      case 'mist':
      case 'fog':
      case 'haze': return '🌫️';
      default: return '🌤️';
    }
  };

  const formatForecastDate = (dateStr: string): string => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  return (
    <section style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '0.85rem',
      marginTop: '0.5rem',
    }}>
      {/* Section Header with Clear Source Distinction Badge */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '0.5rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.1rem' }}>🌤️</span>
          <h2 style={{
            margin: 0,
            fontSize: '0.92rem',
            fontWeight: 700,
            color: '#ffffff',
            letterSpacing: '0.04em',
            textTransform: 'uppercase'
          }}>
            Farm Weather & 5-Day Forecast
          </h2>
          <span style={{
            fontSize: '0.65rem',
            padding: '0.15rem 0.5rem',
            borderRadius: '9999px',
            background: 'rgba(56, 189, 248, 0.15)',
            border: '1px solid rgba(56, 189, 248, 0.35)',
            color: '#38bdf8',
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}>
            📡 Meteorological Station Data • Not Ground Sensors
          </span>
        </div>

        <button
          onClick={() => setIsReportOpen(true)}
          style={{
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            color: '#ffffff',
            borderRadius: '0.5rem',
            padding: '0.35rem 0.75rem',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            transition: 'background 0.2s',
          }}
        >
          <span>📊 View 15-Day Agricultural Report</span>
        </button>
      </div>

      {/* Missing Location Warning Banner */}
      {needsConfig && (
        <div style={{
          background: 'rgba(234, 179, 8, 0.12)',
          border: '1.5px solid rgba(234, 179, 8, 0.45)',
          borderRadius: '0.75rem',
          padding: '1rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
          color: '#fef08a',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '1.5rem' }}>📍</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#facc15' }}>
                Farm Location Not Configured
              </div>
              <div style={{ fontSize: '0.78rem', color: '#fef9c3', marginTop: '0.2rem' }}>
                Weather and rain forecast cannot be retrieved without your farm district or coordinates.
              </div>
            </div>
          </div>
          <Link
            href="/farm"
            style={{
              background: '#eab308',
              color: '#000000',
              padding: '0.45rem 0.9rem',
              borderRadius: '0.5rem',
              fontWeight: 700,
              fontSize: '0.8rem',
              textDecoration: 'none',
            }}
          >
            Configure Farm Profile →
          </Link>
        </div>
      )}

      {/* Main Weather Card */}
      {!needsConfig && (
        <div style={{
          background: 'var(--bg-card, rgba(255,255,255,0.05))',
          border: '1px solid var(--border-subtle, rgba(255,255,255,0.12))',
          borderRadius: '0.85rem',
          padding: '1.25rem',
          boxShadow: 'var(--shadow-card, 0 4px 12px rgba(0,0,0,0.15))',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.25rem',
        }}>
          {loading && !current && (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading local weather observations from OpenWeatherMap...
            </div>
          )}

          {error && !needsConfig && !current && (
            <div style={{ color: '#f87171', fontSize: '0.82rem', padding: '0.5rem' }}>
              ⚠️ {error}
            </div>
          )}

          {current && (
            <>
              {/* Current Overview Row */}
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                paddingBottom: '1rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <div style={{
                    fontSize: '2.8rem',
                    lineHeight: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(255,255,255,0.05)',
                    width: '64px',
                    height: '64px',
                    borderRadius: '1rem',
                  }}>
                    {getWeatherEmoji(current.condition)}
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.35rem' }}>
                      <span style={{ fontSize: '2.2rem', fontWeight: 800, lineHeight: 1 }}>
                        {current.temperature.toFixed(1)}
                      </span>
                      <span style={{ fontSize: '1.1rem', color: 'var(--text-muted)' }}>°C</span>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                        Feels like {current.feels_like.toFixed(1)}°C
                      </span>
                    </div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#f1f5f9', marginTop: '0.2rem' }}>
                      {current.description} • <span style={{ color: 'var(--brand-primary, #4ade80)' }}>{locationName}</span>
                    </div>
                  </div>
                </div>

                {/* Sub-Metrics Grid */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
                  gap: '0.75rem',
                  flex: 1,
                  maxWidth: '520px',
                }}>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.5rem 0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block' }}>Humidity</span>
                    <strong style={{ fontSize: '0.95rem' }}>{current.humidity}%</strong>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.5rem 0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block' }}>Wind Speed</span>
                    <strong style={{ fontSize: '0.95rem' }}>{current.wind_speed} m/s</strong>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.5rem 0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block' }}>Cloud Cover</span>
                    <strong style={{ fontSize: '0.95rem' }}>{current.clouds}%</strong>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.5rem 0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block' }}>Pressure</span>
                    <strong style={{ fontSize: '0.95rem' }}>{current.pressure} hPa</strong>
                  </div>
                </div>
              </div>

              {/* 5-Day Forecast Horizon Strip */}
              {forecastDays.length > 0 && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.65rem' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      5-Day Forecast Horizon (Provider Bound)
                    </span>
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>
                      Updated every 3 hours by OpenWeatherMap
                    </span>
                  </div>

                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                    gap: '0.65rem',
                  }}>
                    {forecastDays.map((day, idx) => (
                      <div key={idx} style={{
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.07)',
                        borderRadius: '0.5rem',
                        padding: '0.65rem',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        textAlign: 'center',
                        gap: '0.35rem',
                      }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                          {formatForecastDate(day.date)}
                        </span>
                        <span style={{ fontSize: '1.4rem' }}>
                          {getWeatherEmoji(day.condition)}
                        </span>
                        <div style={{ fontSize: '0.82rem', fontWeight: 700 }}>
                          <span>{day.temp_max.toFixed(0)}°</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginLeft: '0.25rem' }}>
                            {day.temp_min.toFixed(0)}°
                          </span>
                        </div>
                        {/* Rain Probability Badge */}
                        <div style={{
                          fontSize: '0.68rem',
                          padding: '0.12rem 0.4rem',
                          borderRadius: '4px',
                          background: day.rain_probability_max > 50 ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.05)',
                          color: day.rain_probability_max > 50 ? '#38bdf8' : 'var(--text-muted)',
                          fontWeight: 600,
                        }}>
                          💧 {day.rain_probability_max.toFixed(0)}% rain
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 15-Day Agricultural Telemetry & Forecast Report Modal */}
      <AgriculturalReportModal
        isOpen={isReportOpen}
        onClose={() => setIsReportOpen(false)}
        deviceId={deviceId}
        district={district}
        state={state}
        backendUrl={backendUrl}
      />
    </section>
  );
}
