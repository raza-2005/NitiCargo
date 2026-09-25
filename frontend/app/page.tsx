'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Label,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ArrowDown,
  ArrowUp,
  Anchor,
  Bell,
  Download,
  Fuel,
  Gauge,
  Menu,
  Package,
  RefreshCw,
  Ship,
  SlidersHorizontal,
  Sparkles,
  TrainFront,
  TrendingDown,
  Waves,
  X,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE?.replace(/\/$/, '') || 'http://127.0.0.1:8000'

const ORIGIN_PORTS = [
  'Richards Bay',
  'Durban',
  'Newcastle',
  'Hay Point',
  'Tubarao',
  'Port Hedland',
] as const

const EAST_COAST_PORTS = ['Haldia', 'Paradeep', 'Dhamra', 'Vizag'] as const
const VESSEL_TYPES = ['Capesize', 'Panamax', 'Supramax', 'Handysize'] as const

type EastCoastPort = (typeof EAST_COAST_PORTS)[number]
type VesselType = (typeof VESSEL_TYPES)[number]

type ChartPoint = {
  date: string
  predicted_rate: number
  upper_bound: number
  lower_bound: number
}

type PortConstraint = {
  destination_port: string
  max_draft_m: number
  vessel_type: string
  vessel_draft_m: number
  is_compatible: boolean
  recommended_vessel: string
  message: string
}

type SpotVsTerm = {
  spot_market_cost: number
  term_charter_cost: number
  savings_percentage: number
  savings_amount: number
  cargo_volume_mt: number
}

type VesselCandidate = {
  vessel_type: string
  draft_m: number
  capacity_mt: number
  is_compatible: boolean
  cost_per_mt: number | null
  sailings_required: number | null
}

type BestVesselRecommendation = {
  vessel_type: VesselType
  cost_per_mt: number
  reason: string
  candidates: VesselCandidate[]
}

type PredictResponse = {
  current_predicted_rate: number
  savings_percentage: number
  optimal_charter_date: string
  risk_level: 'Low' | 'Moderate' | 'High'
  chart_data: ChartPoint[]
  port_constraint: PortConstraint
  spot_vs_term: SpotVsTerm
  best_vessel: BestVesselRecommendation
}

type MetricsResponse = {
  r2_score: number
  mape: number
}

type ForecastPoint = {
  day: string
  lower: number
  upper: number
  mean: number
}

const DEFAULT_FUEL_SURGE = 0
const DEFAULT_PORT_DELAY = 0
const DEFAULT_ORIGIN = 'Richards Bay'
const DEFAULT_DESTINATION: EastCoastPort = 'Haldia'
const DEFAULT_CARGO_VOLUME = 55000
const DEFAULT_VESSEL: VesselType = 'Supramax'

function toChartData(chartData: ChartPoint[]): ForecastPoint[] {
  return chartData.map((point) => ({
    day: new Date(point.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    mean: point.predicted_rate,
    lower: point.lower_bound,
    upper: point.upper_bound,
  }))
}

function riskClass(level: PredictResponse['risk_level']) {
  switch (level) {
    case 'Low':
      return 'risk-low'
    case 'Moderate':
      return 'risk-moderate'
    case 'High':
      return 'risk-high'
    default:
      return ''
  }
}

function formatUsd(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

function formatCharterDate(isoDate: string) {
  if (!isoDate || isoDate === '—') return '—'
  const parsed = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return isoDate
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function DeadheadingLabel({
  viewBox,
}: {
  viewBox?: { x?: number; y?: number }
}) {
  const x = viewBox?.x ?? 0
  const y = viewBox?.y ?? 0
  return (
    <g transform={`translate(${x}, ${Math.max(y - 58, 8)})`} className="deadheading-label">
      <rect
        x={-78}
        y={0}
        width={156}
        height={46}
        rx={6}
        fill="#09090b"
        stroke="#fbbf24"
        strokeWidth={1.5}
      />
      <text x={0} y={16} textAnchor="middle" fill="#fde68a" fontSize={10} fontWeight={700}>
        Low Demand / Deadheading Risk
      </text>
      <text x={0} y={32} textAnchor="middle" fill="#a1a1aa" fontSize={9}>
        Lock term charter before trough
      </text>
    </g>
  )
}

function Metric({
  label,
  value,
  delta,
  positive,
  icon: Icon,
  valueClass,
}: {
  label: string
  value: string
  delta: string
  positive?: boolean
  icon: typeof Gauge
  valueClass?: string
}) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span>{label}</span>
        <Icon aria-hidden="true" />
      </div>
      <div className={valueClass ? `metric-value ${valueClass}` : 'metric-value'}>{value}</div>
      <div className={positive ? 'metric-delta good' : 'metric-delta'}>
        {positive ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
        {delta}
      </div>
    </div>
  )
}

export default function Page() {
  const [fuelSurge, setFuelSurge] = useState(DEFAULT_FUEL_SURGE)
  const [portDelay, setPortDelay] = useState(DEFAULT_PORT_DELAY)
  const [originPort, setOriginPort] = useState(DEFAULT_ORIGIN)
  const [destinationPort, setDestinationPort] = useState<EastCoastPort>(DEFAULT_DESTINATION)
  const [cargoVolume, setCargoVolume] = useState(DEFAULT_CARGO_VOLUME)
  const [vesselType, setVesselType] = useState<VesselType>(DEFAULT_VESSEL)
  const [mobileNav, setMobileNav] = useState(false)
  const [refreshed, setRefreshed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [predictedRate, setPredictedRate] = useState<number | null>(null)
  const [savingsPercentage, setSavingsPercentage] = useState<number | null>(null)
  const [riskLevel, setRiskLevel] = useState<PredictResponse['risk_level']>('Low')
  const [optimalCharterDate, setOptimalCharterDate] = useState<string>('—')
  const [chartData, setChartData] = useState<ForecastPoint[]>([])
  const [portConstraint, setPortConstraint] = useState<PortConstraint | null>(null)
  const [spotVsTerm, setSpotVsTerm] = useState<SpotVsTerm | null>(null)
  const [bestVessel, setBestVessel] = useState<BestVesselRecommendation | null>(null)
  const [pdfGenerating, setPdfGenerating] = useState(false)

  const [r2Score, setR2Score] = useState<number | null>(null)
  const [mape, setMape] = useState<number | null>(null)

  const fetchMetrics = useCallback(async () => {
    try {
      const { data } = await axios.get<MetricsResponse>(`${API_BASE}/metrics`)
      setR2Score(data.r2_score)
      setMape(data.mape)
    } catch {
      setError('Unable to reach the backend server. Check that FastAPI is running at http://127.0.0.1:8000.')
    }
  }, [])

  const fetchPrediction = useCallback(
    async (
      fuelValue: number,
      delayValue: number,
      origin: string,
      destination: EastCoastPort,
      volume: number,
      vessel: VesselType,
    ) => {
      setLoading(true)
      setError(null)

      try {
        const { data } = await axios.post<PredictResponse>(`${API_BASE}/predict`, {
          fuel_surge_percent: fuelValue,
          port_delay_days: delayValue,
          origin_port: origin,
          destination_port: destination,
          cargo_volume_mt: volume,
          vessel_type: vessel,
        })

        setPredictedRate(data.current_predicted_rate)
        setSavingsPercentage(data.savings_percentage)
        setRiskLevel(data.risk_level)
        setOptimalCharterDate(data.optimal_charter_date)
        setChartData(toChartData(data.chart_data))
        setPortConstraint(data.port_constraint)
        setSpotVsTerm(data.spot_vs_term)
        setBestVessel(data.best_vessel)
      } catch {
        setError('Prediction request failed. Ensure the FastAPI backend is running at http://127.0.0.1:8000.')
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    fetchMetrics()
    fetchPrediction(
      DEFAULT_FUEL_SURGE,
      DEFAULT_PORT_DELAY,
      DEFAULT_ORIGIN,
      DEFAULT_DESTINATION,
      DEFAULT_CARGO_VOLUME,
      DEFAULT_VESSEL,
    )
  }, [fetchMetrics, fetchPrediction])

  const chartDomain = useMemo(() => {
    if (chartData.length === 0) return [90, 140] as [number, number]
    const values = chartData.flatMap((point) => [point.lower, point.upper])
    const min = Math.floor(Math.min(...values) - 5)
    const max = Math.ceil(Math.max(...values) + 5)
    return [min, max] as [number, number]
  }, [chartData])

  const lowDemandPoint = useMemo(() => {
    if (chartData.length === 0) return null
    return chartData.reduce((lowest, point) => (point.mean < lowest.mean ? point : lowest))
  }, [chartData])

  const displaySavingsPct = spotVsTerm?.savings_percentage ?? savingsPercentage
  const forecastTitle = `${vesselType} / Maritime Freight Rate Outlook`

  const runPrediction = (
    next?: Partial<{
      fuel: number
      delay: number
      origin: string
      destination: EastCoastPort
      volume: number
      vessel: VesselType
    }>,
  ) => {
    fetchPrediction(
      next?.fuel ?? fuelSurge,
      next?.delay ?? portDelay,
      next?.origin ?? originPort,
      next?.destination ?? destinationPort,
      next?.volume ?? cargoVolume,
      next?.vessel ?? vesselType,
    )
  }

  const handleRefresh = async () => {
    setRefreshed(true)
    await Promise.all([
      fetchMetrics(),
      fetchPrediction(fuelSurge, portDelay, originPort, destinationPort, cargoVolume, vesselType),
    ])
    setTimeout(() => setRefreshed(false), 1400)
  }

  const handleFuelChange = (value: number) => {
    setFuelSurge(value)
    runPrediction({ fuel: value })
  }

  const handlePortDelayChange = (value: number) => {
    setPortDelay(value)
    runPrediction({ delay: value })
  }

  const applyRecommendedVessel = () => {
    if (!bestVessel) return
    const nextVessel = bestVessel.vessel_type
    if (!VESSEL_TYPES.includes(nextVessel)) return
    setVesselType(nextVessel)
    runPrediction({ vessel: nextVessel })
  }

  const generateProposalPdf = async () => {
    setPdfGenerating(true)
    setError(null)

    try {
      const response = await axios.post(
        `${API_BASE}/proposal/pdf`,
        {
          fuel_surge_percent: fuelSurge,
          port_delay_days: portDelay,
          origin_port: originPort,
          destination_port: destinationPort,
          cargo_volume_mt: cargoVolume,
          vessel_type: vesselType,
        },
        { responseType: 'blob' },
      )

      const blob = new Blob([response.data], { type: 'application/pdf' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 10)
      link.href = url
      link.download = `NitiCargo_Procurement_Proposal_${destinationPort}_${vesselType}_${stamp}.pdf`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      setError('PDF generation failed. Ensure the FastAPI backend is running at http://127.0.0.1:8000.')
    } finally {
      setPdfGenerating(false)
    }
  }

  const riskDelta =
    riskLevel === 'High'
      ? portConstraint && !portConstraint.is_compatible
        ? 'Draft restriction'
        : 'Elevated exposure'
      : riskLevel === 'Moderate'
        ? 'Monitor closely'
        : 'Within tolerance'

  return (
    <main className={`dashboard-shell${loading ? ' dashboard-loading' : ''}`}>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <TrainFront aria-hidden="true" />
          </div>
          <div>
            <div className="brand-name">MINISTRY OF STEEL</div>
            <div className="brand-sub">FREIGHT INTELLIGENCE</div>
          </div>
        </div>
        <nav className={mobileNav ? 'nav-links open' : 'nav-links'} aria-label="Main navigation">
          <a className="active" href="#overview">
            Overview
          </a>
          <a href="#forecast">Forecast</a>
          <a href="#simulator">Simulator</a>
          <a href="#reports">Reports</a>
        </nav>
        <div className="top-actions">
          <Button variant="ghost" size="icon" aria-label="Notifications">
            <Bell />
          </Button>
          <Button className="refresh-button" onClick={handleRefresh} disabled={loading}>
            <RefreshCw className={refreshed ? 'spin' : ''} data-icon="inline-start" />
            {refreshed ? 'Updated' : 'Refresh data'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            className="menu-button"
            onClick={() => setMobileNav(!mobileNav)}
          >
            {mobileNav ? <X /> : <Menu />}
          </Button>
        </div>
      </header>

      <section className="content" id="overview">
        <div className="eyebrow">
          <span className="status-dot" />
          LIVE OPERATIONS VIEW <span className="eyebrow-separator">/</span> 26 AUG 2026
        </div>
        <div className="title-row">
          <div>
            <h1>Freight Command Center</h1>
            <p>Model your network against the variables that move steel.</p>
          </div>
        </div>

        {bestVessel && (
          <div className="ai-reco-pill" role="status">
            <div className="ai-reco-copy">
              <Sparkles aria-hidden="true" className="ai-reco-icon" />
              <div>
                <span className="ai-reco-label">AI Recommendation</span>
                <strong>
                  {bestVessel.vessel_type} (${bestVessel.cost_per_mt.toFixed(2)}/t — Lowest Cost &
                  Draft Compatible)
                </strong>
              </div>
            </div>
            <Button
              className="ai-reco-apply"
              onClick={applyRecommendedVessel}
              disabled={loading || vesselType === bestVessel.vessel_type}
            >
              <Ship data-icon="inline-start" />
              {vesselType === bestVessel.vessel_type ? 'Recommended Applied' : 'Apply Recommended Vessel'}
            </Button>
          </div>
        )}

        <div className="filter-bar" role="group" aria-label="Route and vessel filters">
          <label className="filter-field">
            <span>
              <Anchor aria-hidden="true" /> Origin Port
            </span>
            <select
              value={originPort}
              onChange={(event) => {
                const value = event.target.value
                setOriginPort(value)
                runPrediction({ origin: value })
              }}
            >
              {ORIGIN_PORTS.map((port) => (
                <option key={port} value={port}>
                  {port}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>
              <Ship aria-hidden="true" /> East Coast Destination
            </span>
            <select
              value={destinationPort}
              onChange={(event) => {
                const value = event.target.value as EastCoastPort
                setDestinationPort(value)
                runPrediction({ destination: value })
              }}
            >
              {EAST_COAST_PORTS.map((port) => (
                <option key={port} value={port}>
                  {port}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            <span>
              <Package aria-hidden="true" /> Cargo Volume (MT)
            </span>
            <input
              type="number"
              min={1000}
              step={1000}
              value={cargoVolume}
              onChange={(event) => {
                const value = Math.max(1000, Number(event.target.value) || 1000)
                setCargoVolume(value)
              }}
              onBlur={(event) => {
                const value = Math.max(1000, Number(event.target.value) || 1000)
                setCargoVolume(value)
                runPrediction({ volume: value })
              }}
            />
          </label>
          <label className="filter-field">
            <span>
              <Ship aria-hidden="true" /> Vessel Type
            </span>
            <select
              value={vesselType}
              onChange={(event) => {
                const value = event.target.value as VesselType
                setVesselType(value)
                runPrediction({ vessel: value })
              }}
            >
              {VESSEL_TYPES.map((vessel) => (
                <option key={vessel} value={vessel}>
                  {vessel}
                </option>
              ))}
            </select>
          </label>
        </div>

        {portConstraint && (
          <div
            className={`constraint-banner${portConstraint.is_compatible ? '' : ' constraint-warn'}`}
            role="status"
          >
            <span className="constraint-label">PORT DRAFT CHECK</span>
            <span>{portConstraint.message}</span>
          </div>
        )}

        <div className="metrics-grid">
          <Metric
            label="Predicted freight rate"
            value={predictedRate != null ? `$${predictedRate.toFixed(2)}` : '—'}
            delta="Live model output"
            icon={Gauge}
          />
          <Metric
            label="Potential savings"
            value={displaySavingsPct != null ? `~${displaySavingsPct.toFixed(0)}%` : '—'}
            delta="Spot vs NitiCargo term charter"
            positive
            icon={TrendingDown}
          />
          <Metric
            label="Model R² score"
            value={r2Score != null ? r2Score.toFixed(4) : '—'}
            delta={mape != null ? `MAPE ${mape.toFixed(2)}%` : 'Loading metrics…'}
            positive={r2Score != null && r2Score > 0.8}
            icon={Ship}
          />
          <Metric
            label="Network risk level"
            value={riskLevel}
            delta={riskDelta}
            icon={Waves}
            valueClass={riskClass(riskLevel)}
          />
        </div>

        <div className="spot-term-widget" id="reports">
          <div className="panel-heading">
            <div>
              <div className="panel-kicker">
                <span className="cyan-line" />
                COST COMPARISON
              </div>
              <h2>Spot vs Term Charter</h2>
              <p>Side-by-side landed cost for the selected cargo volume.</p>
            </div>
            {spotVsTerm && (
              <div className="savings-badge" aria-label="Approximately 26 percent cost savings">
                ~{spotVsTerm.savings_percentage}% cost savings
              </div>
            )}
          </div>
          <div className="spot-term-grid">
            <div className="spot-term-card spot">
              <span className="spot-term-label">Spot Market Cost</span>
              <strong>{spotVsTerm ? formatUsd(spotVsTerm.spot_market_cost) : '—'}</strong>
              <p>Volatile open-market voyage charter</p>
            </div>
            <div className="spot-term-vs" aria-hidden="true">
              VS
            </div>
            <div className="spot-term-card term">
              <span className="spot-term-label">NitiCargo Term Charter Cost</span>
              <strong>{spotVsTerm ? formatUsd(spotVsTerm.term_charter_cost) : '—'}</strong>
              <p>
                Locked-in term rate
                {spotVsTerm ? ` · save ${formatUsd(spotVsTerm.savings_amount)}` : ''}
              </p>
            </div>
          </div>
        </div>

        <div className="main-grid">
          <section className="panel chart-panel" id="forecast">
            <div className="panel-heading">
              <div>
                <div className="panel-kicker">
                  <span className="cyan-line" />
                  RATE FORECAST
                </div>
                <h2>{forecastTitle}</h2>
                <p>USD / metric ton · Next 90 days</p>
              </div>
              <div className="legend">
                <span>
                  <i className="legend-swatch band" />
                  Confidence band
                </span>
                <span>
                  <i className="legend-swatch line" />
                  Predicted mean
                </span>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 28, right: 12, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="bandFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#00bcd4" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="#00bcd4" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#27272A" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#A1A1AA', fontSize: 10 }}
                    interval={Math.max(0, Math.floor(chartData.length / 8))}
                  />
                  <YAxis
                    domain={chartDomain}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#A1A1AA', fontSize: 10 }}
                    tickFormatter={(value) => `$${value}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: '#121212',
                      border: '1px solid #27272A',
                      borderRadius: 6,
                      color: '#FFFFFF',
                      fontSize: 12,
                    }}
                    labelStyle={{ color: '#A1A1AA' }}
                    itemStyle={{ color: '#FFFFFF' }}
                    formatter={(value, name) => [
                      `$${value}`,
                      name === 'mean' ? 'Predicted mean' : name,
                    ]}
                  />
                  <Area type="monotone" dataKey="upper" stroke="none" fill="url(#bandFill)" />
                  <Area type="monotone" dataKey="lower" stroke="none" fill="#000000" />
                  <Area
                    type="monotone"
                    dataKey="mean"
                    stroke="#4dd0e1"
                    strokeWidth={2.5}
                    fill="none"
                    dot={false}
                  />
                  {predictedRate != null && (
                    <ReferenceLine
                      y={predictedRate}
                      stroke="#ffd54f"
                      strokeDasharray="4 4"
                      label={{
                        value: `CURRENT $${predictedRate.toFixed(2)}`,
                        fill: '#A1A1AA',
                        fontSize: 9,
                        position: 'insideTopRight',
                      }}
                    />
                  )}
                  {lowDemandPoint && (
                    <ReferenceDot
                      x={lowDemandPoint.day}
                      y={lowDemandPoint.mean}
                      r={5}
                      fill="#fbbf24"
                      stroke="#000000"
                      strokeWidth={1.5}
                    >
                      <Label
                        content={(props) => (
                          <DeadheadingLabel viewBox={props.viewBox as { x?: number; y?: number }} />
                        )}
                      />
                    </ReferenceDot>
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="chart-footer">
              <span>
                R² Score: <strong>{r2Score != null ? r2Score.toFixed(4) : '—'}</strong>
                {' · '}
                MAPE: <strong>{mape != null ? `${mape.toFixed(2)}%` : '—'}</strong>
              </span>
              <span>{loading ? 'Recalculating…' : 'Live backend forecast'}</span>
            </div>
          </section>

          <aside className="panel simulator-panel" id="simulator">
            <div className="panel-heading">
              <div>
                <div className="panel-kicker">
                  <SlidersHorizontal aria-hidden="true" /> SCENARIO SIMULATOR
                </div>
                <h2>Stress test your network</h2>
                <p>Adjust conditions to see their impact.</p>
              </div>
            </div>
            <div className="sim-controls">
              <label>
                <span>
                  <Fuel aria-hidden="true" />
                  Fuel Price Surge
                </span>
                <output>{fuelSurge}%</output>
              </label>
              <input
                aria-label="Fuel Price Surge"
                type="range"
                min="0"
                max="100"
                value={fuelSurge}
                onChange={(event) => handleFuelChange(Number(event.target.value))}
              />
              <div className="range-labels">
                <span>Low</span>
                <span>Severe</span>
              </div>
              <label>
                <span>
                  <Waves aria-hidden="true" />
                  Port Delay
                </span>
                <output>{portDelay} days</output>
              </label>
              <input
                aria-label="Port Delay"
                type="range"
                min="0"
                max="14"
                value={portDelay}
                onChange={(event) => handlePortDelayChange(Number(event.target.value))}
              />
              <div className="range-labels">
                <span>Normal</span>
                <span>Disrupted</span>
              </div>
            </div>
            <div className="impact-box">
              <div className="impact-top">
                <span>Projected rate</span>
                <strong>{predictedRate != null ? `$${predictedRate.toFixed(2)}/t` : '—'}</strong>
              </div>
              <div className="impact-bar">
                <span
                  style={{
                    width: `${Math.min(100, (savingsPercentage ?? 0) * 3)}%`,
                  }}
                />
              </div>
              <div className="impact-bottom">
                <span>Network risk</span>
                <strong className={riskClass(riskLevel)}>{riskLevel}</strong>
              </div>
            </div>
            <div className="recommendation charter-window">
              <div className="recommendation-icon">
                <TrendingDown aria-hidden="true" />
              </div>
              <div>
                <span>RECOMMENDED VESSEL CHARTERING WINDOW</span>
                <strong>{formatCharterDate(optimalCharterDate)}</strong>
                <p>
                  Potential savings of{' '}
                  <b>
                    {displaySavingsPct != null ? `~${displaySavingsPct.toFixed(0)}%` : '—'}
                  </b>{' '}
                  via NitiCargo term charter vs spot.
                </p>
              </div>
            </div>
            <Button
              className="proposal-button"
              onClick={generateProposalPdf}
              disabled={loading || pdfGenerating}
            >
              {pdfGenerating ? (
                <Loader2 className="spin" data-icon="inline-start" />
              ) : (
                <Download data-icon="inline-start" />
              )}
              {pdfGenerating ? 'Generating PDF...' : 'Generate AI Procurement Proposal PDF'}
            </Button>
          </aside>
        </div>
        <footer className="footer">
          <span>
            <span className="status-dot" />
            {error ? 'Backend connection issue' : 'All systems operational'}
          </span>
          <span>Data refreshes on slider change</span>
          <span>Ministry of Steel © 2026</span>
        </footer>
      </section>
    </main>
  )
}
