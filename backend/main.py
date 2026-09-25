"""
Freight cost predictor API (FastAPI + XGBoost).

Install dependencies:
    pip install fastapi uvicorn xgboost pandas scikit-learn reportlab

Run the server:
    uvicorn main:app --reload
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Literal

import pandas as pd
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sklearn.metrics import mean_absolute_percentage_error, r2_score
from sklearn.model_selection import train_test_split
from xgboost import XGBRegressor

DATA_PATH = Path(__file__).resolve().parent / "freight_dataset.csv"
FEATURE_COLS = [
    "Baltic_Dry_Index",
    "Fuel_Price_USD",
    "Port_Congestion_Days",
    "USD_INR_Rate",
]
TARGET_COL = "Target_Freight_Cost_Per_Ton"
FORECAST_DAYS = 90
WINDOW_DAYS = 7
CI_BAND = 0.05  # +/- 5% around the point prediction
TERM_SAVINGS_RATIO = 0.26  # NitiCargo term charter vs spot (~26%)

EastCoastPort = Literal["Haldia", "Paradeep", "Dhamra", "Vizag"]
VesselType = Literal["Capesize", "Panamax", "Supramax", "Handysize"]

# Typical laden drafts (m) for dry-bulk vessel classes
# Supramax/Handysize modelled as light-draft capable for shallow East Coast berths
VESSEL_DRAFT_M: dict[str, float] = {
    "Capesize": 18.0,
    "Panamax": 14.5,
    "Supramax": 8.0,
    "Handysize": 7.5,
}

# Typical DWT capacity (MT) used for utilization / multi-voyage costing
VESSEL_CAPACITY_MT: dict[str, float] = {
    "Handysize": 35000,
    "Supramax": 55000,
    "Panamax": 75000,
    "Capesize": 180000,
}

# Economies of scale vs Supramax baseline (lower = cheaper $/MT when fully utilized)
VESSEL_SCALE_FACTOR: dict[str, float] = {
    "Capesize": 0.82,
    "Panamax": 0.90,
    "Supramax": 1.00,
    "Handysize": 1.12,
}

# Mild origin-lane cost differentials
ORIGIN_LANE_FACTOR: dict[str, float] = {
    "Richards Bay": 1.00,
    "Durban": 1.02,
    "Newcastle": 1.05,
    "Hay Point": 1.04,
    "Tubarao": 1.08,
    "Port Hedland": 1.06,
}

# East Coast India destination port draft limits (m)
PORT_MAX_DRAFT_M: dict[str, float] = {
    "Haldia": 8.5,
    "Paradeep": 14.5,
    "Dhamra": 18.0,
    "Vizag": 16.5,
}

# Preferred fallback vessel when draft is restricted (smallest compatible first)
VESSEL_PREFERENCE = ["Handysize", "Supramax", "Panamax", "Capesize"]
ALL_VESSELS = ["Handysize", "Supramax", "Panamax", "Capesize"]

# ---------------------------------------------------------------------------
# Data load + model training (once at startup)
# ---------------------------------------------------------------------------
df = pd.read_csv(DATA_PATH)
df["Date"] = pd.to_datetime(df["Date"])
df = df.sort_values("Date").reset_index(drop=True)

X = df[FEATURE_COLS]
y = df[TARGET_COL]
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42
)

model = XGBRegressor(
    n_estimators=100,
    learning_rate=0.05,
    random_state=42,
)
model.fit(X_train, y_train)

y_pred_test = model.predict(X_test)
MODEL_R2 = float(r2_score(y_test, y_pred_test))
MODEL_MAPE = float(mean_absolute_percentage_error(y_test, y_pred_test) * 100)

LATEST_ROW = df.iloc[-1]
LATEST_DATE = pd.Timestamp(LATEST_ROW["Date"])
# Dashboard baseline timeline (matches LIVE OPERATIONS VIEW / 26 AUG 2026)
TIMELINE_ANCHOR = pd.Timestamp("2026-08-26")
BASELINE = {col: float(LATEST_ROW[col]) for col in FEATURE_COLS}

# Damped BDI daily slope from the last two weeks (used only to shape the 90-day path)
_recent = df.tail(14)
_BDI_SLOPE = (
    float(_recent["Baltic_Dry_Index"].iloc[-1] - _recent["Baltic_Dry_Index"].iloc[0])
    / max(len(_recent) - 1, 1)
)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="XGBoost Freight Predictor", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PredictRequest(BaseModel):
    fuel_surge_percent: float = Field(default=0.0, description="Percent change applied to Fuel_Price_USD")
    port_delay_days: int = Field(default=0, description="Extra days added to Port_Congestion_Days")
    origin_port: str = Field(default="Richards Bay", description="Loading / origin port")
    destination_port: EastCoastPort = Field(default="Haldia", description="East Coast India destination")
    cargo_volume_mt: float = Field(default=55000.0, ge=1000, description="Cargo volume in metric tons")
    vessel_type: VesselType = Field(default="Supramax", description="Requested vessel class")


class ChartPoint(BaseModel):
    date: str
    predicted_rate: float
    upper_bound: float
    lower_bound: float


class PortConstraint(BaseModel):
    destination_port: str
    max_draft_m: float
    vessel_type: str
    vessel_draft_m: float
    is_compatible: bool
    recommended_vessel: str
    message: str


class SpotVsTerm(BaseModel):
    spot_market_cost: float
    term_charter_cost: float
    savings_percentage: float
    savings_amount: float
    cargo_volume_mt: float


class VesselCandidate(BaseModel):
    vessel_type: str
    draft_m: float
    capacity_mt: float
    is_compatible: bool
    cost_per_mt: float | None
    sailings_required: int | None = None


class BestVesselRecommendation(BaseModel):
    vessel_type: str
    cost_per_mt: float
    reason: str
    candidates: list[VesselCandidate]


class PredictResponse(BaseModel):
    current_predicted_rate: float
    savings_percentage: float
    optimal_charter_date: str
    risk_level: Literal["Low", "Moderate", "High"]
    chart_data: list[ChartPoint]
    port_constraint: PortConstraint
    spot_vs_term: SpotVsTerm
    best_vessel: BestVesselRecommendation


class MetricsResponse(BaseModel):
    r2_score: float
    mape: float


class ProposalRequest(BaseModel):
    fuel_surge_percent: float = 0.0
    port_delay_days: int = 0
    origin_port: str = "Richards Bay"
    destination_port: EastCoastPort = "Haldia"
    cargo_volume_mt: float = Field(default=55000.0, ge=1000)
    vessel_type: VesselType = "Supramax"


def _round(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


def _check_port_constraint(destination_port: str, vessel_type: str) -> PortConstraint:
    """Draft restriction checks for East Coast ports (e.g. Haldia 8.5m)."""
    max_draft = PORT_MAX_DRAFT_M[destination_port]
    vessel_draft = VESSEL_DRAFT_M[vessel_type]
    is_compatible = vessel_draft <= max_draft

    # Recommend the largest vessel that still fits the port draft
    recommended = "Handysize"
    for candidate in reversed(VESSEL_PREFERENCE):
        if VESSEL_DRAFT_M[candidate] <= max_draft:
            recommended = candidate
            break

    if is_compatible:
        message = (
            f"{vessel_type} (draft {vessel_draft}m) is compatible with "
            f"{destination_port} max draft {max_draft}m."
        )
    else:
        message = (
            f"{destination_port} max draft {max_draft}m restricts {vessel_type} "
            f"(draft {vessel_draft}m). Recommended vessel: {recommended}."
        )

    return PortConstraint(
        destination_port=destination_port,
        max_draft_m=max_draft,
        vessel_type=vessel_type,
        vessel_draft_m=vessel_draft,
        is_compatible=is_compatible,
        recommended_vessel=recommended,
        message=message,
    )


def _landed_cost_per_mt(
    base_rate: float,
    vessel_type: str,
    origin_port: str,
    cargo_volume_mt: float,
) -> tuple[float, int]:
    """
    Landed $/MT for a draft-compatible vessel.
    Applies scale economies, origin lane factor, and multi-voyage capacity logic.
    """
    capacity = VESSEL_CAPACITY_MT[vessel_type]
    scale = VESSEL_SCALE_FACTOR[vessel_type]
    lane = ORIGIN_LANE_FACTOR.get(origin_port, 1.03)
    sailings = max(1, int(math.ceil(cargo_volume_mt / capacity)))

    # Cost of full ship-turns, amortized over actual cargo volume
    voyage_cost = base_rate * scale * lane * capacity * sailings
    cost_per_mt = voyage_cost / max(cargo_volume_mt, 1.0)

    # Mild under-utilization penalty when cargo fills < 45% of a single sailing
    fill_ratio = cargo_volume_mt / (capacity * sailings)
    if fill_ratio < 0.45:
        cost_per_mt *= 1.0 + (0.45 - fill_ratio) * 0.35

    return _round(cost_per_mt), sailings


def recommend_best_vessel(
    base_rate: float,
    origin_port: str,
    destination_port: str,
    cargo_volume_mt: float,
) -> BestVesselRecommendation:
    """
    Evaluate all vessel classes against destination draft limits and
    return the compatible vessel with the lowest landed $/MT.
    """
    max_draft = PORT_MAX_DRAFT_M[destination_port]
    candidates: list[VesselCandidate] = []
    best_type = "Supramax"
    best_cost = float("inf")

    for vessel in ALL_VESSELS:
        draft = VESSEL_DRAFT_M[vessel]
        compatible = draft <= max_draft
        if not compatible:
            candidates.append(
                VesselCandidate(
                    vessel_type=vessel,
                    draft_m=draft,
                    capacity_mt=VESSEL_CAPACITY_MT[vessel],
                    is_compatible=False,
                    cost_per_mt=None,
                    sailings_required=None,
                )
            )
            continue

        cost_per_mt, sailings = _landed_cost_per_mt(
            base_rate, vessel, origin_port, cargo_volume_mt
        )
        candidates.append(
            VesselCandidate(
                vessel_type=vessel,
                draft_m=draft,
                capacity_mt=VESSEL_CAPACITY_MT[vessel],
                is_compatible=True,
                cost_per_mt=cost_per_mt,
                sailings_required=sailings,
            )
        )
        if cost_per_mt < best_cost:
            best_cost = cost_per_mt
            best_type = vessel

    if best_cost == float("inf"):
        # Absolute fallback (should not happen with current port table)
        best_type = "Handysize"
        best_cost, _ = _landed_cost_per_mt(
            base_rate, best_type, origin_port, cargo_volume_mt
        )

    reason = (
        f"{best_type} (${best_cost:.2f}/t — Lowest Cost & Draft Compatible)"
    )

    return BestVesselRecommendation(
        vessel_type=best_type,
        cost_per_mt=_round(best_cost),
        reason=reason,
        candidates=candidates,
    )


def _spot_vs_term(rate_per_ton: float, cargo_volume_mt: float) -> SpotVsTerm:
    spot = rate_per_ton * cargo_volume_mt
    term = spot * (1.0 - TERM_SAVINGS_RATIO)
    savings_amount = spot - term
    return SpotVsTerm(
        spot_market_cost=_round(spot),
        term_charter_cost=_round(term),
        savings_percentage=_round(TERM_SAVINGS_RATIO * 100),
        savings_amount=_round(savings_amount),
        cargo_volume_mt=_round(cargo_volume_mt, 0),
    )


def _shocked_features(day_offset: int, fuel_surge_percent: float, port_delay_days: int) -> dict[str, float]:
    """
    Baseline = most recent CSV row.
    Fuel is shocked by fuel_surge_percent; extra port delay is added, then both
    mean-revert so a 90-day path (and a 7-day charter window) can be formed.
    """
    t = day_offset / max(FORECAST_DAYS - 1, 1)
    fuel_shock = 1.0 + (fuel_surge_percent / 100.0) * (1.0 - 0.65 * t)
    extra_congestion = max(port_delay_days * (1.0 - t), 0.0)
    bdi = BASELINE["Baltic_Dry_Index"] + _BDI_SLOPE * day_offset * 0.25

    return {
        "Baltic_Dry_Index": bdi,
        "Fuel_Price_USD": BASELINE["Fuel_Price_USD"] * fuel_shock,
        "Port_Congestion_Days": BASELINE["Port_Congestion_Days"] + extra_congestion,
        "USD_INR_Rate": BASELINE["USD_INR_Rate"],
    }


def _risk_level(
    fuel_surge_percent: float,
    port_delay_days: int,
    port_compatible: bool,
) -> Literal["Low", "Moderate", "High"]:
    surge = abs(fuel_surge_percent)
    delay = max(port_delay_days, 0)
    if not port_compatible or surge >= 20.0 or delay >= 7:
        return "High"
    if surge >= 8.0 or delay >= 3:
        return "Moderate"
    return "Low"


def _run_prediction(payload: PredictRequest) -> PredictResponse:
    port_constraint = _check_port_constraint(payload.destination_port, payload.vessel_type)

    feature_rows = [
        _shocked_features(day, payload.fuel_surge_percent, payload.port_delay_days)
        for day in range(FORECAST_DAYS)
    ]
    pred_df = pd.DataFrame(feature_rows)[FEATURE_COLS]
    predictions = model.predict(pred_df)

    chart_data: list[ChartPoint] = []
    for day, rate in enumerate(predictions):
        forecast_date = (TIMELINE_ANCHOR + timedelta(days=day + 1)).strftime("%Y-%m-%d")
        point = float(rate)
        chart_data.append(
            ChartPoint(
                date=forecast_date,
                predicted_rate=_round(point),
                upper_bound=_round(point * (1.0 + CI_BAND)),
                lower_bound=_round(point * (1.0 - CI_BAND)),
            )
        )

    current_rate = float(predictions[0])
    best_start = 0
    best_window_avg = float("inf")
    for start in range(FORECAST_DAYS - WINDOW_DAYS + 1):
        window_avg = float(predictions[start : start + WINDOW_DAYS].mean())
        if window_avg < best_window_avg:
            best_window_avg = window_avg
            best_start = start

    savings = 0.0 if current_rate == 0 else max((current_rate - best_window_avg) / current_rate * 100.0, 0.0)
    optimal_date = (TIMELINE_ANCHOR + timedelta(days=best_start + 1)).strftime("%Y-%m-%d")
    spot_vs_term = _spot_vs_term(current_rate, payload.cargo_volume_mt)
    best_vessel = recommend_best_vessel(
        current_rate,
        payload.origin_port,
        payload.destination_port,
        payload.cargo_volume_mt,
    )

    return PredictResponse(
        current_predicted_rate=_round(current_rate),
        savings_percentage=_round(savings),
        optimal_charter_date=optimal_date,
        risk_level=_risk_level(
            payload.fuel_surge_percent,
            payload.port_delay_days,
            port_constraint.is_compatible,
        ),
        chart_data=chart_data,
        port_constraint=port_constraint,
        spot_vs_term=spot_vs_term,
        best_vessel=best_vessel,
    )


def _build_proposal_pdf(prediction: PredictResponse, payload: ProposalRequest) -> bytes:
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title="NitiCargo AI Procurement Proposal",
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TitleDark",
        parent=styles["Heading1"],
        fontSize=16,
        textColor=colors.HexColor("#0f172a"),
        spaceAfter=4,
        alignment=TA_CENTER,
    )
    subtitle_style = ParagraphStyle(
        "SubDark",
        parent=styles["Normal"],
        fontSize=9,
        textColor=colors.HexColor("#475569"),
        alignment=TA_CENTER,
        spaceAfter=12,
    )
    section_style = ParagraphStyle(
        "Section",
        parent=styles["Heading2"],
        fontSize=11,
        textColor=colors.HexColor("#0891b2"),
        spaceBefore=8,
        spaceAfter=4,
    )
    body_style = ParagraphStyle(
        "Body",
        parent=styles["Normal"],
        fontSize=9,
        textColor=colors.HexColor("#1e293b"),
        leading=13,
        alignment=TA_LEFT,
    )
    highlight_style = ParagraphStyle(
        "Highlight",
        parent=styles["Normal"],
        fontSize=10,
        textColor=colors.HexColor("#15803d"),
        leading=13,
        spaceBefore=2,
        spaceAfter=2,
    )

    generated = datetime.now().strftime("%d %b %Y %H:%M")
    charter = prediction.optimal_charter_date
    try:
        charter_fmt = datetime.strptime(charter, "%Y-%m-%d").strftime("%d %b %Y")
    except ValueError:
        charter_fmt = charter

    story = [
        Paragraph("NitiCargo AI Procurement Proposal", title_style),
        Paragraph(
            f"Ministry of Steel · Freight Intelligence · Executive Summary · {generated}",
            subtitle_style,
        ),
        Paragraph("1. Executive Overview & Selected Route", section_style),
        Paragraph(
            f"<b>Route:</b> {payload.origin_port} → {payload.destination_port}<br/>"
            f"<b>Cargo Volume:</b> {payload.cargo_volume_mt:,.0f} MT<br/>"
            f"<b>Selected Vessel:</b> {payload.vessel_type}<br/>"
            f"<b>Predicted Spot Rate:</b> ${prediction.current_predicted_rate:.2f} / MT<br/>"
            f"<b>Scenario:</b> Fuel surge {payload.fuel_surge_percent:.0f}% · "
            f"Port delay {payload.port_delay_days} days",
            body_style,
        ),
        Paragraph("2. Draft Compatibility & AI Best Vessel Validation", section_style),
        Paragraph(
            f"<b>Draft Status:</b> {prediction.port_constraint.message}<br/>"
            f"<b>AI Recommendation:</b> {prediction.best_vessel.vessel_type} at "
            f"${prediction.best_vessel.cost_per_mt:.2f}/MT<br/>"
            f"<b>Rationale:</b> {prediction.best_vessel.reason}",
            body_style,
        ),
    ]

    candidate_rows = [["Vessel", "Draft (m)", "Compatible", "Cost $/MT", "Sailings"]]
    for c in prediction.best_vessel.candidates:
        candidate_rows.append(
            [
                c.vessel_type,
                f"{c.draft_m:.1f}",
                "Yes" if c.is_compatible else "No",
                f"${c.cost_per_mt:.2f}" if c.cost_per_mt is not None else "—",
                str(c.sailings_required) if c.sailings_required else "—",
            ]
        )
    table = Table(candidate_rows, colWidths=[90, 70, 70, 70, 60])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("ALIGN", (1, 0), (-1, -1), "CENTER"),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
                ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f8fafc")),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.extend(
        [
            Spacer(1, 4),
            table,
            Paragraph("3. Spot vs Term Contract Financial Comparison", section_style),
            Paragraph(
                f"<b>Spot Market Cost:</b> ${prediction.spot_vs_term.spot_market_cost:,.2f}<br/>"
                f"<b>NitiCargo Term Charter Cost:</b> ${prediction.spot_vs_term.term_charter_cost:,.2f}<br/>"
                f"<b>Absolute Savings:</b> ${prediction.spot_vs_term.savings_amount:,.2f}",
                body_style,
            ),
            Paragraph(
                f"<b>~{prediction.spot_vs_term.savings_percentage:.0f}% cost savings</b> "
                "by locking NitiCargo term charter versus volatile spot market.",
                highlight_style,
            ),
            Paragraph("4. Recommended 2026 Chartering Window & Risk Metrics", section_style),
            Paragraph(
                f"<b>Recommended Chartering Window:</b> {charter_fmt}<br/>"
                f"<b>Network Risk Level:</b> {prediction.risk_level}<br/>"
                f"<b>Model R² Score:</b> {_round(MODEL_R2, 4)}<br/>"
                f"<b>MAPE:</b> {_round(MODEL_MAPE, 2)}%<br/>"
                f"<b>Charter-window savings vs current rate:</b> "
                f"{prediction.savings_percentage:.2f}%",
                body_style,
            ),
            Spacer(1, 10),
            Paragraph(
                "This one-page executive summary was generated by NitiCargo for Ministry of Steel "
                "procurement decision support. Validate operational constraints with port authorities "
                "before fixture.",
                ParagraphStyle(
                    "FooterNote",
                    parent=body_style,
                    fontSize=8,
                    textColor=colors.HexColor("#64748b"),
                ),
            ),
        ]
    )

    doc.build(story)
    buffer.seek(0)
    return buffer.read()


@app.get("/")
def health_check() -> dict[str, str]:
    return {"status": "online", "model": "XGBoost Freight Predictor"}


@app.get("/metrics", response_model=MetricsResponse)
def metrics() -> MetricsResponse:
    return MetricsResponse(r2_score=_round(MODEL_R2, 4), mape=_round(MODEL_MAPE, 4))


@app.get("/ports")
def ports() -> dict:
    """Reference data for East Coast draft limits and vessel drafts."""
    return {
        "east_coast_ports": PORT_MAX_DRAFT_M,
        "vessel_drafts_m": VESSEL_DRAFT_M,
        "vessel_capacity_mt": VESSEL_CAPACITY_MT,
        "origin_ports": list(ORIGIN_LANE_FACTOR.keys()),
    }


@app.post("/predict", response_model=PredictResponse)
def predict(payload: PredictRequest) -> PredictResponse:
    return _run_prediction(payload)


@app.post("/proposal/pdf")
def proposal_pdf(payload: ProposalRequest) -> StreamingResponse:
    """Generate a 1-page AI procurement proposal PDF for download."""
    prediction = _run_prediction(
        PredictRequest(
            fuel_surge_percent=payload.fuel_surge_percent,
            port_delay_days=payload.port_delay_days,
            origin_port=payload.origin_port,
            destination_port=payload.destination_port,
            cargo_volume_mt=payload.cargo_volume_mt,
            vessel_type=payload.vessel_type,
        )
    )
    pdf_bytes = _build_proposal_pdf(prediction, payload)
    filename = (
        f"NitiCargo_Proposal_{payload.origin_port.replace(' ', '_')}_"
        f"{payload.destination_port}_{payload.vessel_type}.pdf"
    )
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
