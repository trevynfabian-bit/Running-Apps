/**
 * The coach decision engine.
 *
 * This is the component that actually decides what the athlete does today.
 * It is fully deterministic and produces its own explanation. The LLM layer
 * reads this output and rephrases it — it never makes the decision, so a model
 * failure can degrade the prose but can never alter training.
 *
 * How it works
 * ------------
 * Signals are gathered into `Reason`s with signed weights (negative = argues
 * for backing off). The weights are summed into a readiness deficit, which is
 * mapped onto the least disruptive decision that respects the deficit.
 *
 * Coaching hierarchy, applied in order:
 *   1. Safety        — reported pain overrides everything.
 *   2. Recovery      — suppressed physiology caps today's intensity.
 *   3. Consistency   — prefer a modified session over a cancelled one.
 *   4. Goal alignment— protect the sessions that actually drive the goal.
 *   5. Progression   — only add stress when the first four allow it.
 *
 * The bias toward modification over cancellation is deliberate: for most
 * athletes, the failure mode that costs the most fitness is not a slightly-too-
 * hard session, it is the cascade of skipped weeks that follows feeling like
 * they have fallen behind.
 */

import type {
  CoachDecision,
  DecisionType,
  Reason,
  TrainingStateAssessment,
} from '../domain/coaching.js';
import type { PlannedWorkout } from '../domain/workout.js';
import { isHardType } from '../domain/workout.js';
import type { RecoveryState, SubjectiveCheckIn } from '../domain/recovery.js';
import type { TrainingLoadState } from './load.js';
import { clamp, round } from '../util/stats.js';
import { daysBetweenLocalDates } from '../util/time.js';

export interface DecisionInputs {
  athleteId: string;
  /** Local date the decision is for. */
  date: string;
  plannedWorkout?: PlannedWorkout;
  recovery?: RecoveryState;
  trainingState?: TrainingStateAssessment;
  loadState?: TrainingLoadState;
  checkIn?: SubjectiveCheckIn;
  /** Completed hard sessions in the last 7 days, most recent first. */
  recentHardSessionDates?: readonly string[];
  /** Local date of the most recent completed run of any kind. */
  lastRunDate?: string;
  /** Days until the athlete's next A-priority race, if any. */
  daysUntilRace?: number;
  /** True when the plan says this week is a scheduled deload. */
  isDeloadWeek?: boolean;
  /** ID factory so this stays pure. */
  idFactory: () => string;
  now?: Date;
}

export function decideToday(inputs: DecisionInputs): CoachDecision {
  const reasons: Reason[] = [];
  const now = inputs.now ?? new Date();
  const planned = inputs.plannedWorkout;

  // -------------------------------------------------------------------------
  // 1. Safety — reported pain short-circuits the whole engine.
  // -------------------------------------------------------------------------
  if (inputs.checkIn?.hasPain) {
    reasons.push({
      key: 'reported_pain',
      message: 'You reported pain in this morning’s check-in',
      severity: 'warning',
      weight: -10,
      detail: inputs.checkIn.painNote ?? undefined,
    });

    return buildDecision({
      inputs,
      decision: 'REST',
      reasons,
      confidence: 0.9,
      headline: 'Rest recommended today',
      recommendedPlan: planned ? toRest(planned) : undefined,
      now,
      extraExplanation:
        'Training through pain is the one situation where the downside is clearly worse than a missed session. If the pain is sharp, localised, or persists beyond a few days, it is worth having it assessed by a qualified health professional. This app does not diagnose injuries.',
    });
  }

  // Nothing planned — nothing to modify.
  if (!planned || planned.type === 'rest') {
    return buildDecision({
      inputs,
      decision: 'RUN_AS_PLANNED',
      reasons: [
        {
          key: 'rest_day',
          message: 'Today is a scheduled rest day',
          severity: 'info',
          weight: 0,
        },
      ],
      confidence: 1,
      headline: planned ? 'Rest day' : 'Nothing scheduled today',
      now,
    });
  }

  // -------------------------------------------------------------------------
  // 2. Recovery signals
  // -------------------------------------------------------------------------
  if (inputs.recovery) {
    const recovery = inputs.recovery;

    if (recovery.band === 'red') {
      reasons.push({
        key: 'recovery_red',
        message: `Recovery is low (${recovery.score}/100)`,
        severity: 'warning',
        weight: -3,
        detail: recovery.components
          .slice()
          .sort((a, b) => a.score - b.score)
          .slice(0, 2)
          .map((c) => `${c.label}: ${c.detail}`)
          .join('; '),
      });
    } else if (recovery.band === 'yellow') {
      reasons.push({
        key: 'recovery_yellow',
        message: `Recovery is moderate (${recovery.score}/100)`,
        severity: 'caution',
        weight: -1.2,
      });
    } else {
      reasons.push({
        key: 'recovery_green',
        message: `Recovery is good (${recovery.score}/100)`,
        severity: 'info',
        weight: 1,
      });
    }

    // Surface individually alarming components even when the composite is OK,
    // so the athlete sees the specific signal rather than just a number.
    for (const component of recovery.components) {
      if (component.score < 30 && component.key !== 'training_load') {
        reasons.push({
          key: `component_${component.key}`,
          message: `${component.label} is well below your baseline`,
          severity: 'warning',
          weight: -0.8,
          detail: component.detail,
        });
      }
    }

    // A composite built from almost nothing shouldn't drive a big change.
    if (recovery.dataCompleteness < 0.35) {
      reasons.push({
        key: 'low_data_coverage',
        message: 'Only limited recovery data was available today',
        severity: 'info',
        weight: 0.5,
        detail: `Missing: ${recovery.missingSignals.slice(0, 3).join(', ')}.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Hard-day spacing
  // -------------------------------------------------------------------------
  const hardToday = isHardType(planned.type);
  if (hardToday && inputs.recentHardSessionDates?.length) {
    const mostRecent = inputs.recentHardSessionDates[0]!;
    const gap = daysBetweenLocalDates(mostRecent, inputs.date);
    if (gap >= 0 && gap < 2) {
      reasons.push({
        key: 'hard_session_spacing',
        message:
          gap === 0
            ? 'You already completed a hard session today'
            : 'You completed a hard session yesterday',
        severity: 'warning',
        weight: -2.5,
        detail: 'Consecutive hard days limit the quality of both sessions.',
      });
    }

    const hardInLastWeek = inputs.recentHardSessionDates.filter(
      (d) => daysBetweenLocalDates(d, inputs.date) <= 7,
    ).length;
    if (hardInLastWeek >= 3) {
      reasons.push({
        key: 'hard_session_density',
        message: `You have already done ${hardInLastWeek} hard sessions in the last 7 days`,
        severity: 'caution',
        weight: -1.5,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Training state and load
  // -------------------------------------------------------------------------
  if (inputs.trainingState) {
    const state = inputs.trainingState.state;
    if (state === 'overreaching_risk') {
      reasons.push({
        key: 'state_overreaching',
        message: 'Your load is high while recovery signals are suppressed',
        severity: 'warning',
        weight: -3,
      });
    } else if (state === 'highly_fatigued') {
      reasons.push({
        key: 'state_highly_fatigued',
        message: 'You are carrying substantial accumulated fatigue',
        severity: 'warning',
        weight: -2.5,
      });
    } else if (state === 'fatigued') {
      reasons.push({
        key: 'state_fatigued',
        message: 'Fatigue is accumulating faster than you are clearing it',
        severity: 'caution',
        weight: -1.2,
      });
    } else if (state === 'fresh') {
      reasons.push({
        key: 'state_fresh',
        message: 'You are carrying little fatigue',
        severity: 'info',
        weight: 1,
      });
    } else if (state === 'undertrained') {
      reasons.push({
        key: 'state_undertrained',
        message: 'Your recent running volume has been low',
        severity: 'caution',
        weight: -0.8,
        detail: 'Rebuilding consistent easy volume matters more right now than intensity.',
      });
    }
  }

  if (inputs.loadState?.acuteChronicRatio !== undefined) {
    const ratio = inputs.loadState.acuteChronicRatio;
    if (ratio > 1.5) {
      reasons.push({
        key: 'load_ratio_high',
        message: 'Recent training load is well ahead of your established base',
        severity: 'warning',
        weight: -1.5,
        detail: `Acute:chronic load ratio ${ratio.toFixed(2)}.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. Race proximity — protect the taper, don't sabotage race week.
  // -------------------------------------------------------------------------
  if (inputs.daysUntilRace !== undefined && inputs.daysUntilRace >= 0) {
    if (inputs.daysUntilRace <= 2) {
      reasons.push({
        key: 'race_imminent',
        message: `Your race is in ${inputs.daysUntilRace} day${inputs.daysUntilRace === 1 ? '' : 's'}`,
        severity: 'info',
        weight: -2,
        detail: 'Freshness matters more than any fitness you could add now.',
      });
    } else if (inputs.daysUntilRace <= 10 && hardToday) {
      reasons.push({
        key: 'race_taper',
        message: `You are ${inputs.daysUntilRace} days out from your race`,
        severity: 'info',
        weight: -0.8,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Resolve
  // -------------------------------------------------------------------------
  const deficit = reasons.reduce((acc, r) => acc + Math.min(0, r.weight), 0);
  const credit = reasons.reduce((acc, r) => acc + Math.max(0, r.weight), 0);
  const net = deficit + credit;

  const { decision, headline, recommendedPlan } = resolve({
    net,
    planned,
    hardToday,
    isDeloadWeek: inputs.isDeloadWeek ?? false,
    daysUntilRace: inputs.daysUntilRace,
  });

  // Confidence scales with how much evidence there is and how clear-cut it is.
  const evidenceStrength = clamp(Math.abs(net) / 5, 0, 1);
  const coverage = inputs.recovery ? clamp(inputs.recovery.dataCompleteness + 0.3, 0.3, 1) : 0.5;
  const confidence = clamp(0.45 + evidenceStrength * 0.4 * coverage, 0.3, 0.95);

  return buildDecision({
    inputs,
    decision,
    reasons,
    confidence,
    headline,
    recommendedPlan,
    now,
  });
}

function resolve(context: {
  net: number;
  planned: PlannedWorkout;
  hardToday: boolean;
  isDeloadWeek: boolean;
  daysUntilRace?: number;
}): { decision: DecisionType; headline: string; recommendedPlan?: PlannedWorkout } {
  const { net, planned, hardToday, daysUntilRace } = context;
  const isLongRun = planned.type === 'long';

  // Race in the next 2 days: freshness dominates regardless of other signals.
  if (daysUntilRace !== undefined && daysUntilRace <= 2 && hardToday) {
    return {
      decision: 'REDUCE_INTENSITY',
      headline: 'Intensity reduced ahead of race day',
      recommendedPlan: toEasy(planned, 0.6),
    };
  }

  // Severe deficit: rest.
  if (net <= -6) {
    return {
      decision: 'REST',
      headline: 'Rest recommended today',
      recommendedPlan: toRest(planned),
    };
  }

  // Substantial deficit.
  if (net <= -3.5) {
    if (isLongRun) {
      return {
        decision: 'SHORTEN_LONG_RUN',
        headline: 'Long run shortened',
        recommendedPlan: scaleDistance(planned, 0.65, 'Long run shortened to limit accumulated fatigue.'),
      };
    }
    if (hardToday) {
      return {
        decision: 'CHANGE_TO_EASY_RUN',
        headline: `${titleFor(planned.type)} replaced with an easy run`,
        recommendedPlan: toEasy(planned, 0.85),
      };
    }
    return {
      decision: 'CHANGE_TO_RECOVERY_RUN',
      headline: 'Switched to a short recovery run',
      recommendedPlan: toRecovery(planned),
    };
  }

  // Moderate deficit.
  if (net <= -1.8) {
    if (hardToday) {
      return {
        decision: 'REDUCE_INTENSITY',
        headline: 'Intensity reduced for today',
        recommendedPlan: reduceIntensity(planned),
      };
    }
    if (isLongRun) {
      return {
        decision: 'KEEP_LONG_RUN',
        headline: 'Long run kept, but keep it genuinely easy',
      };
    }
    return {
      decision: 'REDUCE_VOLUME',
      headline: 'Volume trimmed slightly',
      recommendedPlan: scaleDistance(planned, 0.8, 'Volume trimmed in response to recovery signals.'),
    };
  }

  // Mild deficit — no structural change, just guidance.
  if (net < 0) {
    return { decision: 'RUN_AS_PLANNED', headline: 'Session stays as planned' };
  }

  return { decision: 'RUN_AS_PLANNED', headline: 'Session stays as planned' };
}

// ---------------------------------------------------------------------------
// Plan transformations
// ---------------------------------------------------------------------------

function titleFor(type: PlannedWorkout['type']): string {
  return type
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function toRest(planned: PlannedWorkout): PlannedWorkout {
  return {
    ...planned,
    type: 'rest',
    title: 'Rest',
    purpose: 'Recovery — protecting the consistency of the rest of the week.',
    targetDistanceMeters: undefined,
    targetDurationSeconds: undefined,
    structure: undefined,
    status: 'modified',
    modifiedFrom: {
      type: planned.type,
      targetDistanceMeters: planned.targetDistanceMeters,
      targetDurationSeconds: planned.targetDurationSeconds,
      reason: 'Replaced with rest.',
    },
  };
}

function toEasy(planned: PlannedWorkout, scale: number): PlannedWorkout {
  const duration = planned.targetDurationSeconds
    ? Math.round(planned.targetDurationSeconds * scale)
    : 45 * 60;
  return {
    ...planned,
    type: 'easy',
    title: 'Easy run',
    purpose: 'Aerobic development without adding intensity today.',
    targetDurationSeconds: duration,
    targetDistanceMeters: planned.targetDistanceMeters
      ? Math.round(planned.targetDistanceMeters * scale)
      : undefined,
    structure: undefined,
    targetRpe: 3,
    status: 'modified',
    modifiedFrom: {
      type: planned.type,
      targetDistanceMeters: planned.targetDistanceMeters,
      targetDurationSeconds: planned.targetDurationSeconds,
      reason: 'Replaced with an easy run.',
    },
  };
}

function toRecovery(planned: PlannedWorkout): PlannedWorkout {
  return {
    ...planned,
    type: 'recovery',
    title: 'Recovery run',
    purpose: 'Blood flow and movement without adding training stress.',
    targetDurationSeconds: Math.min(planned.targetDurationSeconds ?? 30 * 60, 30 * 60),
    targetDistanceMeters: planned.targetDistanceMeters
      ? Math.round(planned.targetDistanceMeters * 0.6)
      : undefined,
    structure: undefined,
    targetRpe: 2,
    status: 'modified',
    modifiedFrom: {
      type: planned.type,
      targetDistanceMeters: planned.targetDistanceMeters,
      targetDurationSeconds: planned.targetDurationSeconds,
      reason: 'Replaced with a recovery run.',
    },
  };
}

function reduceIntensity(planned: PlannedWorkout): PlannedWorkout {
  // Keep the session's shape and purpose, drop the top end of the effort.
  return {
    ...planned,
    title: `${planned.title} (controlled)`,
    purpose: `${planned.purpose} Intensity capped today in response to recovery signals.`,
    targetRpe: planned.targetRpe ? Math.max(2, planned.targetRpe - 2) : 5,
    status: 'modified',
    modifiedFrom: {
      type: planned.type,
      targetDistanceMeters: planned.targetDistanceMeters,
      targetDurationSeconds: planned.targetDurationSeconds,
      reason: 'Intensity reduced.',
    },
  };
}

function scaleDistance(planned: PlannedWorkout, scale: number, reason: string): PlannedWorkout {
  return {
    ...planned,
    targetDistanceMeters: planned.targetDistanceMeters
      ? Math.round(planned.targetDistanceMeters * scale)
      : undefined,
    targetDurationSeconds: planned.targetDurationSeconds
      ? Math.round(planned.targetDurationSeconds * scale)
      : undefined,
    status: 'modified',
    modifiedFrom: {
      type: planned.type,
      targetDistanceMeters: planned.targetDistanceMeters,
      targetDurationSeconds: planned.targetDurationSeconds,
      reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function buildDecision(args: {
  inputs: DecisionInputs;
  decision: DecisionType;
  reasons: Reason[];
  confidence: number;
  headline: string;
  recommendedPlan?: PlannedWorkout;
  now: Date;
  extraExplanation?: string;
}): CoachDecision {
  const { inputs, decision, reasons, confidence, headline, recommendedPlan, now } = args;

  return {
    id: inputs.idFactory(),
    athleteId: inputs.athleteId,
    date: inputs.date,
    decision,
    confidence: round(confidence, 2),
    reasons: reasons.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
    affectedWorkoutId: inputs.plannedWorkout?.id,
    previousPlan: recommendedPlan ? inputs.plannedWorkout : undefined,
    recommendedPlan,
    headline,
    explanation: explain(decision, reasons, args.extraExplanation),
    createdAt: now,
  };
}

/**
 * Assemble the "Why?" text deterministically from the reasons.
 * This is the text the athlete sees when they tap "Why?" — it must always be
 * available, with or without an LLM.
 */
export function explain(
  decision: DecisionType,
  reasons: readonly Reason[],
  extra?: string,
): string {
  const negatives = reasons.filter((r) => r.weight < 0).sort((a, b) => a.weight - b.weight);
  const positives = reasons.filter((r) => r.weight > 0);

  if (decision === 'RUN_AS_PLANNED') {
    if (positives.length === 0 && negatives.length === 0) {
      return 'Nothing in your recent data argues for changing today’s session.';
    }
    const supporting = positives.map((r) => `• ${r.message}`).join('\n');
    const minor =
      negatives.length > 0
        ? `\n\nMinor signals noted but not enough to change the session:\n${negatives
            .slice(0, 2)
            .map((r) => `• ${r.message}`)
            .join('\n')}`
        : '';
    return `Today's session stays as planned.${supporting ? `\n\n${supporting}` : ''}${minor}`;
  }

  const bullets = negatives
    .slice(0, 5)
    .map((r) => `• ${r.message}${r.detail ? ` — ${r.detail}` : ''}`)
    .join('\n');

  const rationale =
    decision === 'REST'
      ? 'The goal is to clear fatigue now rather than accumulate more of it.'
      : 'The goal is not to reduce your progress. It is to protect the consistency that produces it — a modified session you complete is worth more than a hard session you have to recover from for three days.';

  return `Today's session was adjusted because:\n\n${bullets}\n\n${extra ?? rationale}`;
}
