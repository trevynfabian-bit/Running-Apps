# Coaching engine

Every formula the system uses, why it was chosen, and where it breaks down.
This document exists so no number in the app is unexplainable.

---

## 1. Training load

Load is not one formula. Four models are implemented and the best one the data
supports is selected per session; the chosen model is stored so two sessions
computed differently are never silently compared.

| Model | Requires | Confidence |
|---|---|---|
| `trimp_hr` | avg HR, max HR, resting HR | 0.90 |
| `hr_zone` | HR sample stream + zones | 0.75 |
| `srpe` | athlete-reported RPE | 0.65 |
| `duration` | duration only | 0.40 |

**TRIMP (Banister)**

```
load = duration_min × HRR × 0.64 × e^(k × HRR)
HRR  = (HR_avg − HR_rest) / (HR_max − HR_rest)
k    = 1.92 male · 1.67 female · 1.795 unspecified
```

The exponential weighting reflects that intensity costs disproportionately more
than duration. The sex-specific coefficients come from the original literature;
`unspecified` takes the midpoint rather than defaulting to male.

**Session RPE (Foster)** — `minutes × RPE`, divided by 5 to sit on the same
scale as TRIMP. Works with no hardware at all and correlates well with HR-based
measures in practice.

*Limitation.* TRIMP treats an interval session and a steady run with the same
average HR as equivalent, which understates interval cost. The zone model
handles this better when samples exist.

### Acute / chronic load

Exponentially weighted 7-day (acute) and 28-day (chronic) averages, and their
ratio (ACWR).

**ACWR is deliberately de-emphasised.** The evidence for a universal "danger
zone" above 1.5 is weak, and the ratio is unstable when chronic load is low. It
is therefore: suppressed entirely below 21 days of history and 8 active days;
one weighted input among many in the decision engine, never decisive alone;
and confined to detail views rather than the dashboard.

### Monotony and strain (Foster)

`monotony = mean(daily load) / SD(daily load)` over 7 days; `strain = weekly
load × monotony`. High monotony means every day looks the same, which is
associated with poorer adaptation even at moderate volume. Suppressed when
variance is degenerate.

---

## 2. Fitness estimation

**Riegel (1977)** — `T₂ = T₁ × (D₂/D₁)^1.06`

The exponent is a population average; well-trained runners sit nearer 1.04,
under-trained nearer 1.10. Accuracy degrades sharply when extrapolating far,
because a marathon is limited by fuelling and durability rather than aerobic
power alone. Confidence is penalised by extrapolation ratio: beyond 2.5× drops
one level, beyond 4× drops two.

**VDOT (Daniels & Gilbert)**

```
VO2(v)   = −4.60 + 0.182258·v + 0.000104·v²        v in m/min
%max(t)  = 0.8 + 0.1894393·e^(−0.012778·t)
              + 0.2989558·e^(−0.1932605·t)          t in minutes
VDOT     = VO2(v) / %max(t)
```

Inverted numerically by bisection to predict a time at any distance.

Gated to efforts between 3 minutes and 4 hours and at least 1000 m. Below three
minutes performance is dominated by anaerobic capacity, which this model does
not describe — without the gate a 20-second sprint yields a confident,
completely fictional VDOT.

**This is not a measured VO₂max.** It is an estimate of aerobic capacity plus
running economy, and the UI always labels it estimated.

Blending: individual estimates are weighted by recency (8-week half-life) and
source quality (race 1.0, time trial 0.9, detected effort 0.6, self-reported
0.5). Anything older than a year is dropped.

### Confidence

| Level | Requires |
|---|---|
| high | evidence ≤6 weeks old, a real race or time trial, estimates agree within 8% |
| moderate | ≤90 days old, and either a real performance or ≥2 data points |
| low | everything else |

Race predictions blend Riegel and VDOT; disagreement between them above 8%
downgrades confidence further, because disagreement *is* the uncertainty
signal.

---

## 3. Zones

Four methodologies, never mixed. A "Zone 2" from %HRmax is a materially
different intensity from a Zone 2 from heart-rate reserve, so every computed
zone set carries the methodology that produced it.

- `max_hr_percent` — simplest; ignores resting HR, so it overstates intensity
  for athletes with a low resting heart rate.
- `hr_reserve` (Karvonen) — percentages of `HRmax − HRrest`; tracks metabolic
  intensity better.
- `threshold_hr` — anchored to lactate-threshold HR; most defensible when a
  real threshold estimate exists, because threshold is a physiological
  boundary rather than an arbitrary percentage.
- `pace_threshold` / `pace_vdot` — pace zones.

`selectHeartRateMethodology` falls back down the chain when the preferred
anchor is missing, rather than fabricating one.

Max HR falls back to **Tanaka: 208 − 0.7 × age** rather than `220 − age`, which
has markedly lower standard error across adult ages. It is still a population
estimate with roughly ±10 bpm individual spread, used only when no observed
maximum exists.

---

## 4. Aerobic efficiency and drift

**Efficiency factor** — `speed (m/min) ÷ average HR`. Rising EF at constant HR
means more speed for the same cardiovascular cost.

Comparability filtering is aggressive and deliberate. Only steady aerobic runs
≥3 km, under 20 m/km elevation gain, under 28 °C. Heat, hills, treadmill and
interval sessions all move EF independently of fitness, and a trend computed
across them is a weather report. A small honest sample beats a large misleading
one. Minimum four points before any direction is claimed; changes under 2% are
called stable.

**Aerobic decoupling** — split a steady run in half, compare speed-per-beat.

```
drift% = (ratio_first − ratio_second) / ratio_first × 100
```

Validity gates: ≥20 minutes, HR present throughout, and pace coefficient of
variation ≤0.18 (above that it is an interval session, where drift is
meaningless).

Interpretation is explicitly hedged. Below 5% is conventionally "coupled".
Above that, the cause could be heat, dehydration, glycogen depletion,
insufficient aerobic base, or simply starting too fast — **a single session
cannot distinguish them**, and the copy says so rather than asserting one.

---

## 5. Recovery

A composite that deliberately does *not* mirror any provider's score.

| Component | Weight | Scoring |
|---|---|---|
| Device recovery | 0.22 | provider score, ignored while calibrating |
| HRV | 0.20 | vs 14-day personal baseline, −20%→0, +10%→100 |
| Resting HR | 0.15 | vs baseline, +8 bpm→0, −3 bpm→100 |
| Sleep duration | 0.15 | vs personal need, 60%→0, 100%→100 |
| Sleep quality | 0.08 | provider performance % |
| Subjective | 0.12 | energy 0.35, soreness 0.30, stress 0.20, motivation 0.15 |
| Training load | 0.08 | ACWR, ~1.0 neutral |

Two principles:

**No signal dominates.** Weights renormalise across whatever is present, so a
missing WHOOP strap reduces `dataCompleteness` rather than the score.

**Deviation beats absolutes.** An HRV of 45 ms is meaningless alone; 45 ms
against a 62 ms baseline is a signal. The HRV scale is asymmetric on purpose —
suppressed HRV matters more than elevated HRV helps.

Personal sleep need is the 75th percentile of recent nights, not the mean,
because most people are somewhat sleep-restricted on a typical night.

Bands: green ≥67, yellow 40–66, red <40.

---

## 6. The decision engine

Signals become `Reason`s with signed weights. Their sum maps onto the least
disruptive decision that respects it.

**Coaching hierarchy, in order:**

1. **Safety** — reported pain short-circuits everything: `REST`, plus a
   recommendation to see a professional. Never a diagnosis.
2. **Recovery** — suppressed physiology caps today's intensity.
3. **Consistency** — prefer a modified session over a cancelled one.
4. **Goal alignment** — protect the sessions that drive the goal.
5. **Progression** — add stress only when the above allow.

| Net score | Decision |
|---|---|
| ≤ −6 | `REST` |
| ≤ −3.5 | `SHORTEN_LONG_RUN` / `CHANGE_TO_EASY_RUN` / `CHANGE_TO_RECOVERY_RUN` |
| ≤ −1.8 | `REDUCE_INTENSITY` / `REDUCE_VOLUME` / `KEEP_LONG_RUN` |
| > −1.8 | `RUN_AS_PLANNED` |

Signals include recovery band, individually alarming components, hard-day
spacing (consecutive hard days, ≥3 in 7 days), training state, ACWR, and race
proximity (inside 2 days, freshness overrides everything).

**The bias toward modifying over cancelling is deliberate.** For most athletes
the costliest failure is not one slightly-too-hard session — it is the cascade
of skipped weeks that follows feeling behind.

Confidence scales with evidence strength × data coverage, so a decision made
from one signal is reported as less certain than one made from six.

---

## 7. Plan generation

Deterministic: same inputs, same plan.

- **Start from observed volume**, not the template's ambition. A plan opening
  at 150% of current volume is abandoned by week two.
- **Cap weekly growth** at 10%. The "10% rule" is a heuristic, not a law, but
  capping growth is sound regardless of the exact number.
- **Deload every fourth week** to 70%. Continuous ramping is the most common
  self-coaching error.
- **Protect hard/easy separation** — at most two quality sessions, never on
  consecutive days, long run protected as its own stimulus.
- **Respect availability absolutely** — declared rest days and unavailable
  dates are never scheduled over.

The safety invariant enforced by tests is *"no week exceeds the highest volume
reached so far by more than the cap"* — not a naive week-on-week check, because
rebounding out of a deload legitimately jumps ~50% back to a level the athlete
already handled.

Blocks: base → build → specific → taper, weeks distributed by template weight,
volume tapering to ~55% of peak on race week.

---

## 8. Training state

| State | Pattern |
|---|---|
| `overreaching_risk` | high load **and** suppressed recovery together |
| `highly_fatigued` | recovery <38, or strongly negative signal sum |
| `fatigued` | recovery <52 with negative signals |
| `building` | volume/load rising, recovery holding |
| `fresh` | low acute load, good recovery |
| `undertrained` | ≥14 days without running, or <5 km last week |
| `normal` | otherwise |

`overreaching_risk` requires **both** high load and poor recovery. Either alone
is ordinary training; the combination is the pattern worth interrupting. It
describes a training pattern, not a medical condition.

---

## 9. Confidence, everywhere

Every estimate carries confidence derived from data recency, sample count,
internal agreement, and sensor reliability. Trends additionally weigh r² more
heavily than magnitude: a steep slope through scattered points is not evidence,
while a shallow slope through tight points often is.

The honest answer is frequently "not enough data yet", and the system is built
to say it.
