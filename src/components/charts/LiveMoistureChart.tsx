'use client';

import React, { useState, useMemo } from 'react';

export interface MoistureDataPoint {
  timestamp: string;
  time: string;
  field1Moisture: number | null;
  field1Raw: number | null;
  field1Voltage: number | null;
  field2Moisture: number | null;
  field2Raw: number | null;
  field2Voltage: number | null;
}

interface LiveMoistureChartProps {
  history: MoistureDataPoint[];
  field1Name?: string;
  field2Name?: string;
  liveF1?: { moisture: number | null; raw: number | null; voltage: number | null } | null;
  liveF2?: { moisture: number | null; raw: number | null; voltage: number | null } | null;
  isConnected?: boolean;
}

export default function LiveMoistureChart({
  history,
  field1Name = 'Field 1 (A0)',
  field2Name = 'Field 2 (A1)',
  liveF1,
  liveF2,
  isConnected = true,
}: LiveMoistureChartProps) {
  const [viewMode, setViewMode] = useState<'percent' | 'raw' | 'voltage'>('percent');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // SVG dimensions
  const width = 800;
  const height = 260;
  const padding = { top: 25, right: 30, bottom: 40, left: 55 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Compute domain bounds based on viewMode
  const { minY, maxY, unit, formatter } = useMemo(() => {
    if (viewMode === 'percent') {
      return {
        minY: 0,
        maxY: 100,
        unit: '%',
        formatter: (v: number) => `${Math.round(v)}%`,
      };
    }
    if (viewMode === 'voltage') {
      return {
        minY: 0,
        maxY: 3.3,
        unit: 'V',
        formatter: (v: number) => `${v.toFixed(2)}V`,
      };
    }
    // raw ADC counts mode
    const allVals: number[] = [];
    history.forEach((d) => {
      if (d.field1Raw != null) allVals.push(d.field1Raw);
      if (d.field2Raw != null) allVals.push(d.field2Raw);
    });
    if (allVals.length === 0) {
      return { minY: 0, maxY: 25000, unit: 'cts', formatter: (v: number) => `${Math.round(v)}` };
    }
    const minVal = Math.min(...allVals);
    const maxVal = Math.max(...allVals);
    const pad = Math.max(500, (maxVal - minVal) * 0.2);
    return {
      minY: Math.max(0, Math.floor((minVal - pad) / 500) * 500),
      maxY: Math.ceil((maxVal + pad) / 500) * 500,
      unit: 'cts',
      formatter: (v: number) => `${Math.round(v)}`,
    };
  }, [viewMode, history]);

  // Transform data points to SVG coordinates
  const points = useMemo(() => {
    if (history.length === 0) return { f1: [], f2: [] };
    const n = Math.max(history.length - 1, 1);

    const f1 = history.map((d, i) => {
      const x = padding.left + (i / n) * chartW;
      const val =
        viewMode === 'percent'
          ? d.field1Moisture
          : viewMode === 'voltage'
          ? d.field1Voltage
          : d.field1Raw;
      if (val == null) return null;
      const clamped = Math.max(minY, Math.min(maxY, val));
      const y = padding.top + chartH - ((clamped - minY) / (maxY - minY)) * chartH;
      return { x, y, val, time: d.time };
    });

    const f2 = history.map((d, i) => {
      const x = padding.left + (i / n) * chartW;
      const val =
        viewMode === 'percent'
          ? d.field2Moisture
          : viewMode === 'voltage'
          ? d.field2Voltage
          : d.field2Raw;
      if (val == null) return null;
      const clamped = Math.max(minY, Math.min(maxY, val));
      const y = padding.top + chartH - ((clamped - minY) / (maxY - minY)) * chartH;
      return { x, y, val, time: d.time };
    });

    return { f1, f2 };
  }, [history, chartW, chartH, padding.left, padding.top, minY, maxY, viewMode]);

  // Build SVG Path strings
  const buildLinePath = (coords: Array<{ x: number; y: number } | null>) => {
    let d = '';
    let drawing = false;
    coords.forEach((p) => {
      if (!p) {
        drawing = false;
        return;
      }
      if (!drawing) {
        d += `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
        drawing = true;
      } else {
        d += `L ${p.x.toFixed(1)} ${p.y.toFixed(1)} `;
      }
    });
    return d;
  };

  const buildAreaPath = (coords: Array<{ x: number; y: number } | null>) => {
    const valid = coords.filter((p): p is { x: number; y: number } => p !== null);
    if (valid.length < 2) return '';
    const first = valid[0];
    const last = valid[valid.length - 1];
    const baseLine = padding.top + chartH;
    let d = `M ${first.x.toFixed(1)} ${baseLine} L ${first.x.toFixed(1)} ${first.y.toFixed(1)} `;
    for (let i = 1; i < valid.length; i++) {
      d += `L ${valid[i].x.toFixed(1)} ${valid[i].y.toFixed(1)} `;
    }
    d += `L ${last.x.toFixed(1)} ${baseLine} Z`;
    return d;
  };

  const pathF1 = useMemo(() => buildLinePath(points.f1), [points.f1]);
  const areaF1 = useMemo(() => buildAreaPath(points.f1), [points.f1]);
  const pathF2 = useMemo(() => buildLinePath(points.f2), [points.f2]);
  const areaF2 = useMemo(() => buildAreaPath(points.f2), [points.f2]);

  // Y-axis grid ticks (4 ticks)
  const yTicks = useMemo(() => {
    const ticks = [];
    const count = 4;
    for (let i = 0; i <= count; i++) {
      const val = minY + (i / count) * (maxY - minY);
      const y = padding.top + chartH - (i / count) * chartH;
      ticks.push({ val, y });
    }
    return ticks;
  }, [minY, maxY, padding.top, chartH]);

  // Active hover point data
  const hoveredData = hoverIndex !== null && history[hoverIndex] ? history[hoverIndex] : null;

  return (
    <div
      style={{
        background: 'var(--bg-card, rgba(17, 34, 21, 0.7))',
        border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.12))',
        borderRadius: '0.85rem',
        padding: '1.25rem',
        boxShadow: 'var(--shadow-card, 0 4px 20px rgba(0,0,0,0.3))',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        backdropFilter: 'blur(10px)',
      }}
    >
      {/* ─── Header: Title & View Mode Selector ─── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.15rem' }}>📈</span>
          <div>
            <h3
              style={{
                margin: 0,
                fontSize: '1rem',
                fontWeight: 700,
                color: '#ffffff',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              Soil Moisture Dynamics Over Time
              {isConnected && (
                <span
                  style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: '#4ade80',
                    boxShadow: '0 0 8px #4ade80',
                  }}
                  title="Live data streaming"
                />
              )}
            </h3>
            <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.65)' }}>
              Dual-probe telemetry tracking Sensor 1 (A0) and Sensor 2 (A1)
            </span>
          </div>
        </div>

        {/* View Mode Tabs */}
        <div
          style={{
            display: 'flex',
            background: 'rgba(0,0,0,0.35)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '0.5rem',
            padding: '0.2rem',
            gap: '0.25rem',
          }}
        >
          <button
            onClick={() => setViewMode('percent')}
            style={{
              background: viewMode === 'percent' ? 'var(--brand-primary, #4ade80)' : 'transparent',
              color: viewMode === 'percent' ? '#000000' : 'rgba(255,255,255,0.7)',
              border: 'none',
              borderRadius: '0.375rem',
              padding: '0.25rem 0.6rem',
              fontSize: '0.72rem',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            Relative Moisture %
          </button>
          <button
            onClick={() => setViewMode('raw')}
            style={{
              background: viewMode === 'raw' ? 'var(--brand-primary, #4ade80)' : 'transparent',
              color: viewMode === 'raw' ? '#000000' : 'rgba(255,255,255,0.7)',
              border: 'none',
              borderRadius: '0.375rem',
              padding: '0.25rem 0.6rem',
              fontSize: '0.72rem',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            Raw ADC (Counts)
          </button>
          <button
            onClick={() => setViewMode('voltage')}
            style={{
              background: viewMode === 'voltage' ? 'var(--brand-primary, #4ade80)' : 'transparent',
              color: viewMode === 'voltage' ? '#000000' : 'rgba(255,255,255,0.7)',
              border: 'none',
              borderRadius: '0.375rem',
              padding: '0.25rem 0.6rem',
              fontSize: '0.72rem',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            Analog Voltage (V)
          </button>
        </div>
      </div>

      {/* ─── Legend & Current Stats Banner ─── */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          background: 'rgba(0,0,0,0.25)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.5rem',
          padding: '0.5rem 0.85rem',
          fontSize: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          {/* Field 1 Legend Item */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ width: 12, height: 3, background: '#4ade80', borderRadius: 2 }} />
            <span style={{ color: '#4ade80', fontWeight: 700 }}>{field1Name}:</span>
            <span style={{ color: '#ffffff', fontWeight: 600 }}>
              {liveF1?.moisture != null ? `${liveF1.moisture.toFixed(1)}%` : '--'}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.68rem' }}>
              ({liveF1?.raw != null ? `${liveF1.raw} counts` : '--'},{' '}
              {liveF1?.voltage != null ? `${liveF1.voltage.toFixed(3)}V` : '--'})
            </span>
          </div>

          {/* Field 2 Legend Item */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ width: 12, height: 3, background: '#60a5fa', borderRadius: 2 }} />
            <span style={{ color: '#60a5fa', fontWeight: 700 }}>{field2Name}:</span>
            <span style={{ color: '#ffffff', fontWeight: 600 }}>
              {liveF2?.moisture != null ? `${liveF2.moisture.toFixed(1)}%` : '--'}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.68rem' }}>
              ({liveF2?.raw != null ? `${liveF2.raw} counts` : '--'},{' '}
              {liveF2?.voltage != null ? `${liveF2.voltage.toFixed(3)}V` : '--'})
            </span>
          </div>
        </div>

        {/* Hover inspection reading if active */}
        {hoveredData && (
          <div style={{ color: '#facc15', fontSize: '0.72rem', fontWeight: 600 }}>
            Hover ({hoveredData.time}): F1 ={' '}
            {viewMode === 'percent'
              ? `${hoveredData.field1Moisture ?? '--'}%`
              : viewMode === 'voltage'
              ? `${hoveredData.field1Voltage ?? '--'}V`
              : `${hoveredData.field1Raw ?? '--'} cts`}{' '}
            | F2 ={' '}
            {viewMode === 'percent'
              ? `${hoveredData.field2Moisture ?? '--'}%`
              : viewMode === 'voltage'
              ? `${hoveredData.field2Voltage ?? '--'}V`
              : `${hoveredData.field2Raw ?? '--'} cts`}
          </div>
        )}
      </div>

      {/* ─── Responsive SVG Chart ─── */}
      <div style={{ width: '100%', position: 'relative', overflowX: 'auto' }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: '100%', height: 'auto', display: 'block', minWidth: '500px' }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            {/* Field 1 Gradient Fill */}
            <linearGradient id="grad-f1" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4ade80" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#4ade80" stopOpacity="0.0" />
            </linearGradient>
            {/* Field 2 Gradient Fill */}
            <linearGradient id="grad-f2" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#60a5fa" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Background gridlines & Y-axis labels */}
          {yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={padding.left}
                y1={tick.y}
                x2={width - padding.right}
                y2={tick.y}
                stroke="rgba(255, 255, 255, 0.08)"
                strokeDasharray={i === 0 || i === yTicks.length - 1 ? 'none' : '3 3'}
              />
              <text
                x={padding.left - 8}
                y={tick.y + 4}
                fill="rgba(255, 255, 255, 0.5)"
                fontSize="10"
                textAnchor="end"
                fontFamily="monospace"
              >
                {formatter(tick.val)}
              </text>
            </g>
          ))}

          {/* Area Fills */}
          {areaF1 && <path d={areaF1} fill="url(#grad-f1)" />}
          {areaF2 && <path d={areaF2} fill="url(#grad-f2)" />}

          {/* Stroke Lines */}
          {pathF1 && (
            <path
              d={pathF1}
              fill="none"
              stroke="#4ade80"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {pathF2 && (
            <path
              d={pathF2}
              fill="none"
              stroke="#60a5fa"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Data Points on Line */}
          {points.f1.map((p, i) =>
            p ? (
              <circle
                key={`f1-${i}`}
                cx={p.x}
                cy={p.y}
                r={hoverIndex === i ? 5 : 2.5}
                fill="#4ade80"
                stroke="#051006"
                strokeWidth="1.5"
                style={{ transition: 'r 0.15s ease' }}
              />
            ) : null
          )}
          {points.f2.map((p, i) =>
            p ? (
              <circle
                key={`f2-${i}`}
                cx={p.x}
                cy={p.y}
                r={hoverIndex === i ? 5 : 2.5}
                fill="#60a5fa"
                stroke="#051006"
                strokeWidth="1.5"
                style={{ transition: 'r 0.15s ease' }}
              />
            ) : null
          )}

          {/* X-axis Timestamps */}
          {history.map((d, i) => {
            // Label every N points to prevent clutter
            const step = Math.max(1, Math.floor(history.length / 6));
            if (i % step !== 0 && i !== history.length - 1) return null;
            const x =
              padding.left + (i / Math.max(history.length - 1, 1)) * chartW;
            return (
              <text
                key={`time-${i}`}
                x={x}
                y={height - 12}
                fill="rgba(255, 255, 255, 0.45)"
                fontSize="10"
                textAnchor="middle"
                fontFamily="monospace"
              >
                {d.time}
              </text>
            );
          })}

          {/* Hover Crosshair Overlay */}
          {hoverIndex !== null && points.f1[hoverIndex] && (
            <line
              x1={points.f1[hoverIndex]!.x}
              y1={padding.top}
              x2={points.f1[hoverIndex]!.x}
              y2={padding.top + chartH}
              stroke="#facc15"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
          )}

          {/* Invisible hover capture rects for interactive points */}
          {history.map((_, i) => {
            const n = Math.max(history.length - 1, 1);
            const x = padding.left + (i / n) * chartW;
            const stepW = chartW / n;
            return (
              <rect
                key={`hit-${i}`}
                x={x - stepW / 2}
                y={padding.top}
                width={stepW}
                height={chartH}
                fill="transparent"
                style={{ cursor: 'crosshair' }}
                onMouseEnter={() => setHoverIndex(i)}
              />
            );
          })}
        </svg>

        {/* Empty state overlay */}
        {history.length === 0 && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: 'rgba(255, 255, 255, 0.5)',
              fontSize: '0.85rem',
              textAlign: 'center',
            }}
          >
            Awaiting streaming data points from ESP32 on COM5...
          </div>
        )}
      </div>

      {/* ─── Mandatory Agronomic Disclaimer (Requirement 7) ─── */}
      <div
        style={{
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          paddingTop: '0.6rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontSize: '0.72rem',
          color: 'rgba(255, 255, 255, 0.65)',
        }}
      >
        <span>ℹ️</span>
        <span>
          <strong>Note on Moisture Percentages:</strong> Values represent a{' '}
          <em>calibrated relative moisture index (0–100%)</em> mapped from raw ADS1115 capacitive voltages. They are not direct volumetric water content (VWC) percentages in soil.
        </span>
      </div>
    </div>
  );
}
