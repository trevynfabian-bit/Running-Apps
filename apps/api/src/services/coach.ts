/**
 * AI coach.
 *
 * Two hard rules govern this module.
 *
 * 1. The LLM never decides training. `decideToday` in @running/core produces
 *    the actual recommendation; the model only explains and contextualises it.
 *    If the model is unavailable, misconfigured, or returns nonsense, the
 *    athlete still gets a correct decision and a coherent explanation.
 *
 * 2. The model is never handed the database. It receives a compact, curated
 *    context object built here — summaries and derived metrics, not raw rows.
 *    That bounds the token cost, keeps the prompt legible, and means a
 *    prompt-injection style attack has nothing interesting to reach.
 *
 * Answers are grounded: every factual claim must come from the supplied
 * context, and the model is instructed to say it lacks data rather than
 * inventing a number.
 */

import type { CoachResponseDto } from '@running/contracts';
import {
  decideToday,
  formatDuration,
  formatPace,
  toLocalDate,
  type CoachDecision,
} from '@running/core';
import { randomUUID } from 'node:crypto';

import { env } from '../env.js';
import { logger } from '../observability/logger.js';
import type { AthleteContext } from './athlete-context.js';
import { currentWeekSummary, predictForDistance, weeklyIntensityDistribution } from './athlete-context.js';

/**
 * The curated view handed to the model. Deliberately small and pre-digested:
 * summaries the model can quote, not rows it must interpret.
 */
export interface CoachContext {
  athlete: {
    name: string;
    experience: string;
    timezone: string;
    units: string;
  };
  today: string;
  readiness: { score: number; band: string; summary: string; dataCompleteness: number };
  trainingState: { state: string; summary: string; confidence: number };
  todayWorkout?: {
    title: string;
    type: string;
    purpose: string;
    targetDistanceKm?: number;
    targetDurationMinutes?: number;
    status: string;
  };
  decision?: { decision: string; headline: string; reasons: string[]; confidence: number };
  recentWorkouts: {
    date: string;
    type: string;
    distanceKm?: number;
    duration?: string;
    pace?: string;
    avgHeartRate?: number;
  }[];
  weekSoFar: {
    completedKm: number;
    plannedKm: number;
    completedSessions: number;
    plannedSessions: number;
    longestRunKm: number;
    easySharePercent?: number;
  };
  recovery: {
    last7DayAverage?: number;
    lastNightSleepHours?: number;
    hrvTrend?: string;
    restingHeartRate?: number;
  };
  fitness: {
    estimatedVo2Max?: number;
    thresholdPace?: string;
    easyPaceRange?: string;
    confidence: string;
    basis: string;
  };
  aerobicEfficiency?: { direction: string; changePercent: number; confidence: string; summary: string };
  trainingLoad?: {
    acuteChronicRatio?: number;
    weeklyLoad: number;
    interpretation: string;
  };
  currentBlock?: { name: string; goal: string; weekInBlock: number; weeksInBlock: number };
  raceGoal?: {
    name: string;
    date: string;
    distanceKm: number;
    targetTime?: string;
    currentEstimate?: string;
    gap?: string;
    weeksRemaining: number;
  };
  /** Signals that are absent, so the model knows what it cannot speak to. */
  missingData: string[];
}

export function buildCoachContext(context: AthleteContext): CoachContext {
  const week = currentWeekSummary(context);
  const intensity = weeklyIntensityDistribution(context);

  const recent = context.recentRuns
    .slice(-10)
    .reverse()
    .map((w) => ({
      date: toLocalDate(w.startTime, w.timezone),
      type: w.type,
      distanceKm: w.distanceMeters ? Number((w.distanceMeters / 1000).toFixed(2)) : undefined,
      duration: w.movingTimeSeconds ? formatDuration(w.movingTimeSeconds) : undefined,
      pace: w.avgPaceSecondsPerKm ? formatPace(w.avgPaceSecondsPerKm) : undefined,
      avgHeartRate: w.avgHeartRateBpm ? Math.round(w.avgHeartRateBpm) : undefined,
    }));

  const recentRecoveryScores = context.recentRecoveryStates.slice(-7).map((r) => r.score);
  const last7DayAverage =
    recentRecoveryScores.length > 0
      ? Math.round(recentRecoveryScores.reduce((a, b) => a + b, 0) / recentRecoveryScores.length)
      : undefined;

  const lastNightSleep = context.sleepRecords.find((s) => s.date === context.today);

  const missingData: string[] = [...context.recovery.missingSignals];
  if (!context.plan) missingData.push('No active training plan');
  if (context.fitness.vdot === undefined) missingData.push('No fitness estimate (needs a race or time trial)');
  if (!context.nextRace) missingData.push('No race goal set');

  const block = currentBlockFor(context);

  return {
    athlete: {
      name: context.profile.displayName,
      experience:
        (context.profile.background as { experience?: string })?.experience ?? 'recreational',
      timezone: context.timezone,
      units: context.profile.units,
    },
    today: context.today,
    readiness: {
      score: context.recovery.score,
      band: context.recovery.band,
      summary: context.recovery.summary,
      dataCompleteness: context.recovery.dataCompleteness,
    },
    trainingState: {
      state: context.trainingState.state,
      summary: context.trainingState.summary,
      confidence: context.trainingState.confidence,
    },
    todayWorkout: context.plan?.todayWorkout
      ? {
          title: context.plan.todayWorkout.title,
          type: context.plan.todayWorkout.type,
          purpose: context.plan.todayWorkout.purpose,
          targetDistanceKm: context.plan.todayWorkout.targetDistanceMeters
            ? Number((context.plan.todayWorkout.targetDistanceMeters / 1000).toFixed(1))
            : undefined,
          targetDurationMinutes: context.plan.todayWorkout.targetDurationSeconds
            ? Math.round(context.plan.todayWorkout.targetDurationSeconds / 60)
            : undefined,
          status: context.plan.todayWorkout.status,
        }
      : undefined,
    recentWorkouts: recent,
    weekSoFar: {
      completedKm: Number((week.completedDistanceMeters / 1000).toFixed(1)),
      plannedKm: Number((week.plannedDistanceMeters / 1000).toFixed(1)),
      completedSessions: week.completedSessions,
      plannedSessions: week.plannedSessions,
      longestRunKm: Number((week.longestRunMeters / 1000).toFixed(1)),
      easySharePercent: intensity ? Math.round(intensity.easyShare * 100) : undefined,
    },
    recovery: {
      last7DayAverage,
      lastNightSleepHours: lastNightSleep
        ? Number((lastNightSleep.totalSleepSeconds / 3600).toFixed(1))
        : undefined,
      hrvTrend: context.recovery.components.find((c) => c.key === 'hrv')?.detail,
      restingHeartRate: context.restingHeartRateBpm
        ? Math.round(context.restingHeartRateBpm)
        : undefined,
    },
    fitness: {
      estimatedVo2Max: context.fitness.estimatedVo2Max
        ? Number(context.fitness.estimatedVo2Max.toFixed(1))
        : undefined,
      thresholdPace: context.fitness.thresholdPaceSecondsPerKm
        ? formatPace(context.fitness.thresholdPaceSecondsPerKm)
        : undefined,
      easyPaceRange: context.fitness.easyPaceRangeSecondsPerKm
        ? `${formatPace(context.fitness.easyPaceRangeSecondsPerKm[0])}–${formatPace(context.fitness.easyPaceRangeSecondsPerKm[1])}`
        : undefined,
      confidence: context.fitness.confidence,
      basis: context.fitness.basis,
    },
    aerobicEfficiency: context.efficiency
      ? {
          direction: context.efficiency.direction,
          changePercent: context.efficiency.changePercent,
          confidence: context.efficiency.confidence,
          summary: context.efficiency.interpretation,
        }
      : undefined,
    trainingLoad: context.loadState
      ? {
          acuteChronicRatio: context.loadState.acuteChronicRatio
            ? Number(context.loadState.acuteChronicRatio.toFixed(2))
            : undefined,
          weeklyLoad: Math.round(context.loadState.weeklyLoad),
          interpretation: describeLoad(context.loadState.acuteChronicRatio),
        }
      : undefined,
    currentBlock: block,
    raceGoal: context.nextRace
      ? buildRaceContext(context)
      : undefined,
    missingData,
  };
}

function currentBlockFor(context: AthleteContext): CoachContext['currentBlock'] {
  if (!context.plan) return undefined;
  const block = context.plan.blocks.find(
    (b) => b.startDate <= context.today && b.endDate >= context.today,
  );
  if (!block) return undefined;

  const weekInBlock =
    Math.floor(
      (Date.parse(`${context.today}T00:00:00Z`) - Date.parse(`${block.startDate}T00:00:00Z`)) /
        (7 * 86_400_000),
    ) + 1;

  return {
    name: block.name,
    goal: block.goal,
    weekInBlock,
    weeksInBlock: block.durationWeeks,
  };
}

function buildRaceContext(context: AthleteContext): CoachContext['raceGoal'] {
  const race = context.nextRace!;
  const prediction = predictForDistance(context, race.distanceMeters);
  const weeksRemaining = Math.max(
    0,
    Math.ceil(
      (Date.parse(`${race.date}T00:00:00Z`) - Date.parse(`${context.today}T00:00:00Z`)) /
        (7 * 86_400_000),
    ),
  );

  const gap =
    race.targetDurationSeconds && prediction
      ? prediction.predictedDurationSeconds - race.targetDurationSeconds
      : undefined;

  return {
    name: race.name,
    date: race.date,
    distanceKm: Number((race.distanceMeters / 1000).toFixed(1)),
    targetTime: race.targetDurationSeconds ? formatDuration(race.targetDurationSeconds) : undefined,
    currentEstimate: prediction ? formatDuration(prediction.predictedDurationSeconds) : undefined,
    gap: gap !== undefined ? `${gap > 0 ? '+' : '−'}${formatDuration(Math.abs(gap))}` : undefined,
    weeksRemaining,
  };
}

function describeLoad(ratio: number | undefined): string {
  if (ratio === undefined) return 'Not enough history to judge load balance yet.';
  if (ratio > 1.5) return 'Recent load is well above the established base.';
  if (ratio > 1.25) return 'Load is climbing faster than the established base.';
  if (ratio < 0.75) return 'Recent load is below the established base.';
  return 'Load is balanced against the established base.';
}

// ---------------------------------------------------------------------------
// Today's decision
// ---------------------------------------------------------------------------

export function computeTodayDecision(context: AthleteContext): CoachDecision | undefined {
  if (!context.plan?.todayWorkout) {
    return decideToday({
      athleteId: context.profile.id,
      date: context.today,
      recovery: context.recovery,
      trainingState: context.trainingState,
      loadState: context.loadState,
      checkIn: context.checkIn,
      idFactory: () => randomUUID(),
    });
  }

  const planned = context.plan.todayWorkout;
  const daysUntilRace = context.nextRace
    ? Math.round(
        (Date.parse(`${context.nextRace.date}T00:00:00Z`) -
          Date.parse(`${context.today}T00:00:00Z`)) /
          86_400_000,
      )
    : undefined;

  return decideToday({
    athleteId: context.profile.id,
    date: context.today,
    plannedWorkout: {
      id: planned.id,
      planId: planned.planId,
      blockId: planned.blockId,
      date: planned.date,
      type: planned.type as 'easy',
      title: planned.title,
      purpose: planned.purpose,
      targetDistanceMeters: planned.targetDistanceMeters ?? undefined,
      targetDurationSeconds: planned.targetDurationSeconds ?? undefined,
      targetRpe: planned.targetRpe ?? undefined,
      status: planned.status as 'planned',
    },
    recovery: context.recovery,
    trainingState: context.trainingState,
    loadState: context.loadState,
    checkIn: context.checkIn,
    recentHardSessionDates: context.recentHardSessionDates,
    daysUntilRace: daysUntilRace !== undefined && daysUntilRace >= 0 ? daysUntilRace : undefined,
    idFactory: () => randomUUID(),
  });
}

// ---------------------------------------------------------------------------
// Conversational coach
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the running coach inside a performance app. You are speaking to the athlete whose data appears below.

GROUNDING — this is the most important rule:
- Every factual claim you make MUST come from the supplied context.
- Never invent a workout, a heart rate, a pace, a sleep figure or a race prediction.
- If the context does not contain what is needed, say plainly that you do not have that data, and say what would produce it (e.g. "complete a time trial").
- The context lists missingData. Do not speak to anything in that list as if you had it.

EPISTEMIC HONESTY — label what kind of statement you are making:
- fact: a number directly in the context (e.g. distance run this week)
- derived: something computed from those numbers (e.g. a percentage change)
- estimate: a modelled projection (VO2max, race predictions, threshold pace)
- interpretation: what the pattern suggests
- recommendation: what to do next
Never present an estimate as a measurement.

DECISIONS — you do not make them:
- Today's training recommendation has already been decided by the app's deterministic engine and appears in the context as "decision".
- Your job is to explain that decision and answer questions about it. Do not contradict it or invent a different one.

MEDICAL BOUNDARY:
- You are a performance coach, not a clinician. Never diagnose.
- If the athlete describes pain or worrying symptoms, recommend they consult a qualified health professional.

VOICE:
- Direct, calm, specific, evidence-oriented. Talk like an experienced coach.
- Cite the actual numbers. "Your pace improved 14 s/km at the same heart rate over six weeks" beats "great progress!".
- Do not be effusive or use exclamation marks. No "crushing it", no cheerleading.
- Be concise. Two to five sentences unless genuinely more is needed.`;

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
}

/**
 * Answer an athlete question.
 * Falls back to a deterministic responder when no model is configured or the
 * call fails, so the coach tab always works.
 */
export async function answerCoachQuestion(args: {
  question: string;
  context: AthleteContext;
  decision?: CoachDecision;
  history?: { role: 'user' | 'assistant'; content: string }[];
}): Promise<CoachResponseDto> {
  const config = env();
  const coachContext = buildCoachContext(args.context);

  if (args.decision) {
    coachContext.decision = {
      decision: args.decision.decision,
      headline: args.decision.headline,
      reasons: args.decision.reasons.map((r) => r.message),
      confidence: args.decision.confidence,
    };
  }

  if (!config.aiConfigured) {
    return deterministicAnswer(args.question, coachContext, args.decision);
  }

  try {
    const response = await fetch(`${config.AI_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.AI_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.AI_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          ...(args.history ?? []).slice(-6),
          {
            role: 'user',
            content: `ATHLETE CONTEXT (JSON):\n${JSON.stringify(coachContext, null, 2)}\n\nQUESTION:\n${args.question}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      logger.warn('coach.llm.http_error', { status: response.status });
      return deterministicAnswer(args.question, coachContext, args.decision);
    }

    const body = (await response.json()) as AnthropicResponse;
    const text = body.content
      ?.filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();

    if (!text) return deterministicAnswer(args.question, coachContext, args.decision);

    return {
      answer: text,
      confidence: confidenceFromContext(coachContext),
      dataUsed: describeDataUsed(coachContext),
      warnings: coachContext.missingData.length > 0 ? coachContext.missingData.slice(0, 3) : undefined,
    };
  } catch (error) {
    logger.warn('coach.llm.failed', { error: String(error) });
    return deterministicAnswer(args.question, coachContext, args.decision);
  }
}

function confidenceFromContext(context: CoachContext): 'low' | 'moderate' | 'high' {
  if (context.readiness.dataCompleteness > 0.7 && context.recentWorkouts.length >= 5) return 'high';
  if (context.readiness.dataCompleteness > 0.35 || context.recentWorkouts.length >= 3) {
    return 'moderate';
  }
  return 'low';
}

function describeDataUsed(context: CoachContext): string[] {
  const used: string[] = [];
  if (context.recentWorkouts.length > 0) used.push(`${context.recentWorkouts.length} recent workouts`);
  if (context.readiness.dataCompleteness > 0) used.push('Recovery and sleep signals');
  if (context.fitness.estimatedVo2Max !== undefined) used.push('Fitness estimate');
  if (context.trainingLoad) used.push('Training load history');
  if (context.raceGoal) used.push('Race goal');
  return used;
}

/**
 * Deterministic responder.
 *
 * Not a stub: it pattern-matches the common questions and answers them from
 * the same context the model would have received. This is what runs when no
 * AI key is configured, which is the default developer setup.
 */
export function deterministicAnswer(
  question: string,
  context: CoachContext,
  decision?: CoachDecision,
): CoachResponseDto {
  const q = question.toLowerCase();
  const base = {
    confidence: confidenceFromContext(context),
    dataUsed: describeDataUsed(context),
    generatedWithoutLlm: true,
    warnings: context.missingData.length > 0 ? context.missingData.slice(0, 3) : undefined,
  };

  // "Why is today's run easy?" / "why was my workout changed?"
  if (/why.*(today|workout|session|easy|changed|modified|adjust)/.test(q)) {
    if (decision) {
      return {
        ...base,
        answer: `${decision.headline}.\n\n${decision.explanation}`,
        recommendation: decision.recommendedPlan?.title,
        claims: decision.reasons.map((r) => ({ kind: 'fact' as const, text: r.message })),
      };
    }
    return { ...base, answer: 'There is no session scheduled for today, so nothing was adjusted.' };
  }

  // "Am I getting faster / fitter?"
  if (/(getting|am i).*(fast|fit|better|improv)|progress/.test(q)) {
    if (!context.aerobicEfficiency) {
      return {
        ...base,
        answer:
          'I do not have enough comparable easy runs yet to judge whether your fitness is moving. Complete a few more steady aerobic runs with heart rate recorded and I can compare pace at the same effort.',
      };
    }
    return {
      ...base,
      answer: context.aerobicEfficiency.summary,
      claims: [
        { kind: 'derived', text: `Aerobic efficiency is ${context.aerobicEfficiency.direction}.` },
        {
          kind: 'interpretation',
          text: `Change of ${context.aerobicEfficiency.changePercent}% with ${context.aerobicEfficiency.confidence} confidence.`,
        },
      ],
      keyMetrics: context.fitness.estimatedVo2Max
        ? [
            {
              label: 'Estimated VO₂max',
              value: String(context.fitness.estimatedVo2Max),
              context: context.fitness.basis,
            },
          ]
        : undefined,
    };
  }

  // "Should I run tomorrow?" / "can I add another session?"
  if (/should i (run|train)|can i (add|increase)|more mileage|extra session/.test(q)) {
    const ratio = context.trainingLoad?.acuteChronicRatio;
    const cautious = context.readiness.band === 'red' || (ratio !== undefined && ratio > 1.4);
    return {
      ...base,
      answer: cautious
        ? `I would hold steady for now. ${context.readiness.summary} ${context.trainingLoad?.interpretation ?? ''}`.trim()
        : `Your current signals support it. ${context.readiness.summary} ${context.trainingLoad?.interpretation ?? ''}`.trim(),
      recommendation: cautious
        ? 'Keep this week at its current volume and reassess after two or three good recovery days.'
        : 'A modest increase is reasonable — add easy volume rather than another hard session.',
    };
  }

  // "Why am I tired?" / "why is my heart rate high?"
  if (/tired|fatigue|exhaust|heart rate.*(high|elevated)|why.*rhr/.test(q)) {
    const weakest = context.recovery;
    return {
      ...base,
      answer: `${context.trainingState.summary}\n\n${context.readiness.summary}${
        weakest.lastNightSleepHours ? ` You slept ${weakest.lastNightSleepHours} hours last night.` : ''
      }`,
      claims: [
        { kind: 'fact', text: `Readiness score ${context.readiness.score}/100.` },
        { kind: 'interpretation', text: context.trainingState.summary },
      ],
    };
  }

  // Race questions
  if (/race|goal|sub-?\d|target time|ready/.test(q)) {
    if (!context.raceGoal) {
      return {
        ...base,
        answer: 'You do not have a race goal set. Add one and I can track the gap between your current projection and your target.',
      };
    }
    const race = context.raceGoal;
    return {
      ...base,
      answer: `${race.name} is in ${race.weeksRemaining} week(s). ${
        race.currentEstimate
          ? `Your current projection is ${race.currentEstimate}${race.targetTime ? ` against a ${race.targetTime} target (${race.gap})` : ''}.`
          : 'I do not have enough data for a reliable projection yet.'
      }`,
      keyMetrics: race.currentEstimate
        ? [
            { label: 'Projected', value: race.currentEstimate, context: context.fitness.basis },
            ...(race.targetTime ? [{ label: 'Target', value: race.targetTime }] : []),
          ]
        : undefined,
    };
  }

  // "What should I do this week?"
  if (/this week|weekly|what should i/.test(q)) {
    return {
      ...base,
      answer: `You are ${context.weekSoFar.completedKm} km into a ${context.weekSoFar.plannedKm} km week, with ${context.weekSoFar.completedSessions} of ${context.weekSoFar.plannedSessions} sessions done.${
        context.currentBlock
          ? ` You are in week ${context.currentBlock.weekInBlock} of ${context.currentBlock.weeksInBlock} of your ${context.currentBlock.name} block — ${context.currentBlock.goal.toLowerCase()}.`
          : ''
      }`,
      keyMetrics: [
        {
          label: 'This week',
          value: `${context.weekSoFar.completedKm} / ${context.weekSoFar.plannedKm} km`,
        },
      ],
    };
  }

  // Fallback: summarise state honestly rather than guessing at the question.
  return {
    ...base,
    answer: `Here is where you stand today. ${context.readiness.summary} ${context.trainingState.summary}${
      context.todayWorkout ? ` Today's session is ${context.todayWorkout.title.toLowerCase()}.` : ''
    }\n\nI can answer questions about your training load, recovery, progress, or race goal.`,
  };
}
