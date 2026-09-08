/**
 * Training plan generation.
 *
 * Produces a periodised plan from the athlete's current fitness, availability
 * and goal. The generator is deterministic: the same inputs always yield the
 * same plan, which makes it testable and makes "why does my plan look like
 * this?" answerable.
 *
 * Principles encoded here
 * -----------------------
 * Progressive overload with recovery. Volume rises for two to three weeks,
 * then steps down for a deload week. Continuous ramping is the most common
 * self-coaching error and the one most associated with injury.
 *
 * Start from what the athlete actually does, not from what the template
 * wants. A plan that opens at 150% of the athlete's current volume is a plan
 * they will abandon in week two, so week one is anchored to observed volume.
 *
 * Cap weekly progression. Week-on-week increases are capped (the familiar
 * "10% rule" is a rough heuristic, not a law, but capping growth is sound
 * regardless of the exact number).
 *
 * Easy days easy. At most two quality sessions per week, never on consecutive
 * days, and the long run is protected as its own stimulus.
 *
 * Respect availability. Rest days the athlete declared are never scheduled
 * over. A plan that ignores someone's Wednesday is not a plan they can follow.
 */

import type {
  ProgramTemplateId,
  TrainingBlock,
  TrainingBlockType,
  TrainingPlan,
} from '../domain/training.js';
import type {
  DayOfWeek,
  TrainingAvailability,
  AthleteConstraints,
} from '../domain/athlete.js';
import type {
  PlannedWorkout,
  WorkoutStructure,
  WorkoutType,
} from '../domain/workout.js';
import type { FitnessEstimate } from './fitness.js';
import { clamp } from '../util/stats.js';
import {
  addDaysToLocalDate,
  daysBetweenLocalDates,
  localDayOfWeek,
  startOfWeek,
} from '../util/time.js';

export interface PlanGenerationInputs {
  athleteId: string;
  template: ProgramTemplateId;
  /** Local date the plan starts. Snapped to the following Monday. */
  startDate: string;
  /** Total plan length. Derived from the race date when there is one. */
  totalWeeks: number;
  availability: TrainingAvailability;
  constraints: AthleteConstraints;
  fitness: FitnessEstimate;
  /** Observed current weekly volume in metres — the anchor for week one. */
  currentWeeklyDistanceMeters: number;
  /** Observed longest recent run in metres. */
  longestRecentRunMeters?: number;
  raceGoalId?: string;
  /** Local race date, when the plan is targeting one. */
  raceDate?: string;
  raceDistanceMeters?: number;
  idFactory: (kind: 'plan' | 'block' | 'workout') => string;
  now?: Date;
}

/** Shape of a program template: block sequence and volume characteristics. */
interface TemplateDefinition {
  name: string;
  /** Relative block weighting, used to distribute the available weeks. */
  blocks: { type: TrainingBlockType; weight: number; goal: string }[];
  /** Peak weekly volume as a multiple of starting volume. */
  peakVolumeMultiplier: number;
  /** Long run as a share of weekly volume at peak. */
  longRunShareAtPeak: number;
  /** Quality (hard) sessions per week during the build phase. */
  qualitySessionsInBuild: number;
  /** Absolute floor on weekly volume, metres. */
  minWeeklyDistanceMeters: number;
}

const TEMPLATES: Record<ProgramTemplateId, TemplateDefinition> = {
  beginner_5k: {
    name: 'Beginner 5K',
    blocks: [
      { type: 'base', weight: 3, goal: 'Build the habit and a basic aerobic base' },
      { type: 'build', weight: 2, goal: 'Introduce sustained running and light speed' },
      { type: 'taper', weight: 0.5, goal: 'Arrive fresh' },
    ],
    peakVolumeMultiplier: 1.6,
    longRunShareAtPeak: 0.32,
    qualitySessionsInBuild: 1,
    minWeeklyDistanceMeters: 8000,
  },
  improve_5k: {
    name: '5K Improvement',
    blocks: [
      { type: 'base', weight: 2, goal: 'Rebuild aerobic volume' },
      { type: 'build', weight: 2, goal: 'Raise threshold and running economy' },
      { type: 'specific', weight: 1.5, goal: 'Sharpen at 5K race pace' },
      { type: 'taper', weight: 0.5, goal: 'Arrive fresh' },
    ],
    peakVolumeMultiplier: 1.35,
    longRunShareAtPeak: 0.28,
    qualitySessionsInBuild: 2,
    minWeeklyDistanceMeters: 15000,
  },
  road_10k: {
    name: '10K',
    blocks: [
      { type: 'base', weight: 2.5, goal: 'Build aerobic volume and durability' },
      { type: 'build', weight: 2, goal: 'Develop lactate threshold' },
      { type: 'specific', weight: 1.5, goal: 'Consolidate at 10K race pace' },
      { type: 'taper', weight: 0.5, goal: 'Arrive fresh' },
    ],
    peakVolumeMultiplier: 1.4,
    longRunShareAtPeak: 0.3,
    qualitySessionsInBuild: 2,
    minWeeklyDistanceMeters: 18000,
  },
  half_marathon: {
    name: 'Half Marathon',
    blocks: [
      { type: 'base', weight: 3, goal: 'Build aerobic volume and long-run durability' },
      { type: 'build', weight: 2.5, goal: 'Develop threshold and sustained pace' },
      { type: 'specific', weight: 1.5, goal: 'Race-pace specificity and fuelling practice' },
      { type: 'taper', weight: 1, goal: 'Shed fatigue, keep sharpness' },
    ],
    peakVolumeMultiplier: 1.5,
    longRunShareAtPeak: 0.33,
    qualitySessionsInBuild: 2,
    minWeeklyDistanceMeters: 25000,
  },
  marathon: {
    name: 'Marathon',
    blocks: [
      { type: 'base', weight: 3.5, goal: 'Build a deep aerobic base' },
      { type: 'build', weight: 3, goal: 'Raise threshold and extend the long run' },
      { type: 'specific', weight: 2, goal: 'Marathon-pace work and fuelling rehearsal' },
      { type: 'taper', weight: 1.2, goal: 'Shed fatigue while holding fitness' },
    ],
    peakVolumeMultiplier: 1.6,
    longRunShareAtPeak: 0.34,
    qualitySessionsInBuild: 2,
    minWeeklyDistanceMeters: 35000,
  },
  aerobic_base: {
    name: 'Aerobic Base',
    blocks: [{ type: 'base', weight: 1, goal: 'Raise aerobic capacity with easy volume' }],
    peakVolumeMultiplier: 1.4,
    longRunShareAtPeak: 0.3,
    qualitySessionsInBuild: 0,
    minWeeklyDistanceMeters: 12000,
  },
  return_to_running: {
    name: 'Return to Running',
    blocks: [
      { type: 'recovery', weight: 1, goal: 'Re-establish running with minimal stress' },
      { type: 'base', weight: 2, goal: 'Rebuild continuous easy running' },
    ],
    peakVolumeMultiplier: 1.8,
    longRunShareAtPeak: 0.28,
    qualitySessionsInBuild: 0,
    minWeeklyDistanceMeters: 5000,
  },
  general_fitness: {
    name: 'General Running Fitness',
    blocks: [
      { type: 'base', weight: 2, goal: 'Consistent aerobic running' },
      { type: 'build', weight: 1, goal: 'Add variety and light intensity' },
    ],
    peakVolumeMultiplier: 1.25,
    longRunShareAtPeak: 0.3,
    qualitySessionsInBuild: 1,
    minWeeklyDistanceMeters: 10000,
  },
  custom: {
    name: 'Custom Goal',
    blocks: [
      { type: 'base', weight: 2, goal: 'Build aerobic base' },
      { type: 'build', weight: 2, goal: 'Develop threshold' },
    ],
    peakVolumeMultiplier: 1.35,
    longRunShareAtPeak: 0.3,
    qualitySessionsInBuild: 1,
    minWeeklyDistanceMeters: 12000,
  },
};

/** Maximum week-on-week volume increase during a build week. */
const MAX_WEEKLY_INCREASE = 0.1;
/** Volume multiplier applied on a deload week. */
const DELOAD_MULTIPLIER = 0.7;
/** Build weeks between deloads. */
const BUILD_WEEKS_PER_CYCLE = 3;

export function generateTrainingPlan(inputs: PlanGenerationInputs): TrainingPlan {
  const now = inputs.now ?? new Date();
  const template = TEMPLATES[inputs.template];
  const planId = inputs.idFactory('plan');

  // Plans start on a Monday so weeks line up with the athlete's mental model.
  const startDate = startOfWeek(addDaysToLocalDate(inputs.startDate, 6));
  const totalWeeks = Math.max(1, Math.round(inputs.totalWeeks));
  const endDate = addDaysToLocalDate(startDate, totalWeeks * 7 - 1);

  const notes: string[] = [];

  // --- Volume plan ---------------------------------------------------------
  const startVolume = Math.max(
    template.minWeeklyDistanceMeters * 0.6,
    inputs.currentWeeklyDistanceMeters > 0
      ? inputs.currentWeeklyDistanceMeters
      : template.minWeeklyDistanceMeters,
  );

  if (inputs.currentWeeklyDistanceMeters <= 0) {
    notes.push(
      'No recent training volume was available, so week one starts at a conservative default for this program.',
    );
  } else {
    notes.push(
      `Week one is anchored to your recent weekly volume of ${(startVolume / 1000).toFixed(1)} km.`,
    );
  }

  const weeklyVolumes = buildVolumeProgression(startVolume, totalWeeks, template);

  // --- Blocks --------------------------------------------------------------
  const blocks = buildBlocks({
    template,
    planId,
    startDate,
    totalWeeks,
    weeklyVolumes,
    idFactory: inputs.idFactory,
  });

  // --- Sessions ------------------------------------------------------------
  const runDays = resolveRunDays(inputs.availability);
  if (runDays.length === 0) {
    notes.push('No available training days were configured, so no sessions could be scheduled.');
  }

  const workouts: PlannedWorkout[] = [];
  for (const block of blocks) {
    for (let weekInBlock = 0; weekInBlock < block.durationWeeks; weekInBlock++) {
      const weekStart = addDaysToLocalDate(block.startDate, weekInBlock * 7);
      const weekIndexInPlan = daysBetweenLocalDates(startDate, weekStart) / 7;
      const weeklyTarget = block.weeklyDistanceTargetsMeters[weekInBlock] ?? 0;

      workouts.push(
        ...buildWeek({
          planId,
          block,
          weekStart,
          weeklyTargetMeters: weeklyTarget,
          weekIndexInPlan,
          totalWeeks,
          template,
          availability: inputs.availability,
          constraints: inputs.constraints,
          runDays,
          fitness: inputs.fitness,
          raceDate: inputs.raceDate,
          raceDistanceMeters: inputs.raceDistanceMeters,
          idFactory: inputs.idFactory,
        }),
      );
    }
  }

  if (inputs.constraints.unavailableDates.length > 0) {
    notes.push(
      `${inputs.constraints.unavailableDates.length} date(s) you marked unavailable were left clear.`,
    );
  }
  if (template.qualitySessionsInBuild > 0) {
    notes.push(
      `Up to ${template.qualitySessionsInBuild} quality session(s) per week, never on consecutive days.`,
    );
  }
  notes.push(
    `Volume steps down to ${Math.round(DELOAD_MULTIPLIER * 100)}% every ${BUILD_WEEKS_PER_CYCLE + 1} weeks to consolidate adaptation.`,
  );

  return {
    id: planId,
    athleteId: inputs.athleteId,
    name: template.name,
    template: inputs.template,
    status: 'active',
    startDate,
    endDate,
    raceGoalId: inputs.raceGoalId,
    blocks,
    workouts,
    generationBasis: {
      weeklyDistanceMetersAtStart: Math.round(startVolume),
      sessionsPerWeek: runDays.length,
      estimatedThresholdPaceSecondsPerKm: inputs.fitness.thresholdPaceSecondsPerKm,
      estimatedEasyPaceSecondsPerKm: inputs.fitness.easyPaceRangeSecondsPerKm?.[1],
      notes,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Build the week-by-week volume curve: three build weeks then a deload,
 * ramping toward the template's peak and tapering into race day.
 */
function buildVolumeProgression(
  startVolume: number,
  totalWeeks: number,
  template: TemplateDefinition,
): number[] {
  const peak = startVolume * template.peakVolumeMultiplier;
  const taperWeeks = Math.min(
    totalWeeks - 1,
    Math.max(1, Math.round(totalWeeks * 0.12)),
  );
  const buildWeeks = Math.max(1, totalWeeks - taperWeeks);

  const volumes: number[] = [];
  let current = startVolume;

  for (let week = 0; week < buildWeeks; week++) {
    const isDeload = week > 0 && (week + 1) % (BUILD_WEEKS_PER_CYCLE + 1) === 0;

    if (isDeload) {
      // A deload dips below the trend without resetting it: `current` keeps
      // tracking the progression so the following week resumes from where the
      // build left off. The rebound out of a deload can therefore exceed the
      // week-on-week cap, which is correct — it returns to a volume the
      // athlete already absorbed two weeks earlier rather than exceeding it.
      // The invariant that actually matters is enforced below: no week ever
      // exceeds the highest volume reached so far by more than the cap.
      volumes.push(current * DELOAD_MULTIPLIER);
      continue;
    }

    if (week > 0) {
      // Ramp toward peak, but never faster than the weekly cap allows.
      const remaining = Math.max(0, buildWeeks - week);
      const desiredStep = remaining > 0 ? (peak - current) / remaining : 0;
      const cappedStep = Math.min(desiredStep, current * MAX_WEEKLY_INCREASE);
      current = Math.min(peak, current + Math.max(0, cappedStep));
    }
    volumes.push(current);
  }

  // Taper: step down toward ~55% of peak on race week.
  for (let week = 0; week < taperWeeks; week++) {
    const progress = taperWeeks === 1 ? 1 : (week + 1) / taperWeeks;
    volumes.push(current * (1 - 0.45 * progress));
  }

  return volumes.slice(0, totalWeeks).map((v) => Math.round(v));
}

function buildBlocks(args: {
  template: TemplateDefinition;
  planId: string;
  startDate: string;
  totalWeeks: number;
  weeklyVolumes: number[];
  idFactory: (kind: 'plan' | 'block' | 'workout') => string;
}): TrainingBlock[] {
  const { template, planId, startDate, totalWeeks, weeklyVolumes, idFactory } = args;

  const totalWeight = template.blocks.reduce((acc, b) => acc + b.weight, 0);

  // Distribute weeks proportionally, guaranteeing each block at least one week.
  const rawWeeks = template.blocks.map((b) => (b.weight / totalWeight) * totalWeeks);
  const weeks = rawWeeks.map((w) => Math.max(1, Math.floor(w)));

  // Hand out any remainder to the blocks with the largest fractional parts.
  let allocated = weeks.reduce((a, b) => a + b, 0);
  const fractional = rawWeeks
    .map((w, i) => ({ i, frac: w - Math.floor(w) }))
    .sort((a, b) => b.frac - a.frac);

  let cursor = 0;
  while (allocated < totalWeeks && fractional.length > 0) {
    const target = fractional[cursor % fractional.length]!;
    weeks[target.i] = (weeks[target.i] ?? 1) + 1;
    allocated++;
    cursor++;
  }
  // If rounding overshot, trim from the largest block that can spare a week.
  while (allocated > totalWeeks) {
    const largest = weeks.reduce((best, w, i) => (w > (weeks[best] ?? 0) ? i : best), 0);
    if ((weeks[largest] ?? 0) <= 1) break;
    weeks[largest] = (weeks[largest] ?? 1) - 1;
    allocated--;
  }

  const blocks: TrainingBlock[] = [];
  let weekOffset = 0;

  for (let i = 0; i < template.blocks.length; i++) {
    const definition = template.blocks[i]!;
    const durationWeeks = weeks[i] ?? 1;
    if (durationWeeks <= 0) continue;

    const blockStart = addDaysToLocalDate(startDate, weekOffset * 7);
    const blockEnd = addDaysToLocalDate(blockStart, durationWeeks * 7 - 1);

    blocks.push({
      id: idFactory('block'),
      planId,
      type: definition.type,
      name: blockLabel(definition.type),
      goal: definition.goal,
      startDate: blockStart,
      endDate: blockEnd,
      durationWeeks,
      orderIndex: i,
      weeklyDistanceTargetsMeters: weeklyVolumes.slice(weekOffset, weekOffset + durationWeeks),
    });

    weekOffset += durationWeeks;
  }

  return blocks;
}

function blockLabel(type: TrainingBlockType): string {
  const labels: Record<TrainingBlockType, string> = {
    base: 'Base',
    build: 'Build',
    specific: 'Specific',
    peak: 'Peak',
    taper: 'Taper',
    race: 'Race',
    recovery: 'Recovery',
  };
  return labels[type];
}

/** Run days, minus anything the athlete declared as rest. */
function resolveRunDays(availability: TrainingAvailability): DayOfWeek[] {
  const rest = new Set(availability.restDays);
  const days = availability.runDays.filter((d) => !rest.has(d));
  // Respect the athlete's session cap.
  return days.slice(0, Math.max(0, availability.maxSessionsPerWeek));
}

interface WeekArgs {
  planId: string;
  block: TrainingBlock;
  weekStart: string;
  weeklyTargetMeters: number;
  weekIndexInPlan: number;
  totalWeeks: number;
  template: TemplateDefinition;
  availability: TrainingAvailability;
  constraints: AthleteConstraints;
  runDays: DayOfWeek[];
  fitness: FitnessEstimate;
  raceDate?: string;
  raceDistanceMeters?: number;
  idFactory: (kind: 'plan' | 'block' | 'workout') => string;
}

/**
 * Lay out one week: long run on the athlete's chosen day, quality sessions
 * spaced apart, everything else easy.
 */
function buildWeek(args: WeekArgs): PlannedWorkout[] {
  const {
    planId,
    block,
    weekStart,
    weeklyTargetMeters,
    template,
    availability,
    constraints,
    runDays,
    fitness,
    idFactory,
  } = args;

  if (runDays.length === 0 || weeklyTargetMeters <= 0) return [];

  const unavailable = new Set(constraints.unavailableDates);

  // Map each run day to its local date within this week (Monday-anchored).
  const dayDates = runDays
    .map((day) => {
      // startOfWeek gives Monday; convert 0=Sun..6=Sat into a Monday offset.
      const offset = day === 0 ? 6 : day - 1;
      return { day, date: addDaysToLocalDate(weekStart, offset) };
    })
    .filter((d) => !unavailable.has(d.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (dayDates.length === 0) return [];

  // --- Race day ------------------------------------------------------------
  if (args.raceDate && args.raceDistanceMeters) {
    const raceWithinWeek =
      daysBetweenLocalDates(weekStart, args.raceDate) >= 0 &&
      daysBetweenLocalDates(weekStart, args.raceDate) <= 6;
    if (raceWithinWeek) {
      return buildRaceWeek(args, dayDates);
    }
  }

  // --- Assign roles --------------------------------------------------------
  const longRunEntry =
    dayDates.find((d) => d.day === availability.longRunDay) ?? dayDates[dayDates.length - 1]!;

  const qualityCount = qualitySessionsFor(block.type, template);
  const qualityDates = pickQualityDays(
    dayDates.filter((d) => d.date !== longRunEntry.date),
    longRunEntry.date,
    qualityCount,
  );

  // --- Distribute volume ---------------------------------------------------
  const longRunShare = clamp(
    template.longRunShareAtPeak * (block.type === 'base' ? 0.92 : 1),
    0.2,
    0.4,
  );
  const longRunMeters = Math.round(weeklyTargetMeters * longRunShare);
  const remainingMeters = Math.max(0, weeklyTargetMeters - longRunMeters);
  const otherDays = dayDates.filter((d) => d.date !== longRunEntry.date);
  const perOtherDay = otherDays.length > 0 ? remainingMeters / otherDays.length : 0;

  const easyPace = fitness.easyPaceRangeSecondsPerKm;
  const thresholdPace = fitness.thresholdPaceSecondsPerKm;

  const workouts: PlannedWorkout[] = [];

  for (const entry of dayDates) {
    const isLong = entry.date === longRunEntry.date;
    const isQuality = qualityDates.has(entry.date);

    if (isLong) {
      workouts.push(
        makeWorkout({
          planId,
          block,
          date: entry.date,
          type: 'long',
          title: 'Long run',
          purpose: 'Aerobic durability and long-run endurance.',
          distanceMeters: longRunMeters,
          paceRange: easyPace,
          rpe: 4,
          idFactory,
        }),
      );
      continue;
    }

    if (isQuality) {
      const qualityType = pickQualityType(block.type, workouts);
      workouts.push(
        makeWorkout({
          planId,
          block,
          date: entry.date,
          type: qualityType,
          title: qualityTitle(qualityType),
          purpose: qualityPurpose(qualityType),
          distanceMeters: Math.round(perOtherDay * 1.05),
          paceRange: easyPace,
          rpe: qualityType === 'intervals' ? 8 : 7,
          structure: buildQualityStructure(qualityType, thresholdPace, perOtherDay),
          idFactory,
        }),
      );
      continue;
    }

    workouts.push(
      makeWorkout({
        planId,
        block,
        date: entry.date,
        type: 'easy',
        title: 'Easy run',
        purpose: 'Aerobic development at conversational effort.',
        distanceMeters: Math.round(perOtherDay),
        paceRange: easyPace,
        rpe: 3,
        idFactory,
      }),
    );
  }

  return workouts;
}

function buildRaceWeek(
  args: WeekArgs,
  dayDates: { day: DayOfWeek; date: string }[],
): PlannedWorkout[] {
  const { planId, block, fitness, idFactory } = args;
  const workouts: PlannedWorkout[] = [];

  for (const entry of dayDates) {
    if (entry.date === args.raceDate) {
      workouts.push(
        makeWorkout({
          planId,
          block,
          date: entry.date,
          type: 'race',
          title: 'Race day',
          purpose: 'Execute the goal race.',
          distanceMeters: args.raceDistanceMeters,
          rpe: 10,
          idFactory,
        }),
      );
      continue;
    }

    const daysToRace = daysBetweenLocalDates(entry.date, args.raceDate!);
    // Keep the legs moving, add nothing.
    workouts.push(
      makeWorkout({
        planId,
        block,
        date: entry.date,
        type: daysToRace <= 2 ? 'recovery' : 'easy',
        title: daysToRace <= 2 ? 'Shakeout' : 'Easy run',
        purpose: 'Stay sharp without adding fatigue before race day.',
        distanceMeters: daysToRace <= 2 ? 4000 : 6000,
        paceRange: fitness.easyPaceRangeSecondsPerKm,
        rpe: 2,
        idFactory,
      }),
    );
  }

  return workouts;
}

function qualitySessionsFor(blockType: TrainingBlockType, template: TemplateDefinition): number {
  switch (blockType) {
    case 'base':
      return Math.min(1, template.qualitySessionsInBuild);
    case 'build':
    case 'specific':
      return template.qualitySessionsInBuild;
    case 'peak':
      return template.qualitySessionsInBuild;
    case 'taper':
      return Math.min(1, template.qualitySessionsInBuild);
    case 'race':
    case 'recovery':
      return 0;
  }
}

/**
 * Choose quality days that are not adjacent to each other or to the long run.
 * Falls back to the best available spacing when the week is too tight.
 */
function pickQualityDays(
  candidates: { day: DayOfWeek; date: string }[],
  longRunDate: string,
  count: number,
): Set<string> {
  const chosen = new Set<string>();
  if (count <= 0 || candidates.length === 0) return chosen;

  // Score each candidate by its minimum distance from the long run and from
  // days already chosen; greedily take the best-spaced day each round.
  for (let i = 0; i < count; i++) {
    let best: { date: string; score: number } | undefined;

    for (const candidate of candidates) {
      if (chosen.has(candidate.date)) continue;

      const distances = [Math.abs(daysBetweenLocalDates(longRunDate, candidate.date))];
      for (const taken of chosen) {
        distances.push(Math.abs(daysBetweenLocalDates(taken, candidate.date)));
      }
      const score = Math.min(...distances);

      if (!best || score > best.score) best = { date: candidate.date, score };
    }

    // Refuse to stack hard days back-to-back unless there is no alternative.
    if (best && (best.score >= 2 || chosen.size === 0)) chosen.add(best.date);
  }

  return chosen;
}

function pickQualityType(
  blockType: TrainingBlockType,
  existing: readonly PlannedWorkout[],
): WorkoutType {
  const alreadyHasIntervals = existing.some((w) => w.type === 'intervals');

  switch (blockType) {
    case 'base':
      // Base blocks get strides/tempo rather than hard intervals.
      return 'tempo';
    case 'build':
      return alreadyHasIntervals ? 'threshold' : 'intervals';
    case 'specific':
      return alreadyHasIntervals ? 'race_simulation' : 'threshold';
    case 'peak':
      return alreadyHasIntervals ? 'threshold' : 'intervals';
    case 'taper':
      return 'strides';
    default:
      return 'easy';
  }
}

function qualityTitle(type: WorkoutType): string {
  const titles: Partial<Record<WorkoutType, string>> = {
    intervals: 'Intervals',
    threshold: 'Threshold run',
    tempo: 'Tempo run',
    race_simulation: 'Race-pace session',
    strides: 'Easy run + strides',
    hills: 'Hill repeats',
  };
  return titles[type] ?? 'Quality session';
}

function qualityPurpose(type: WorkoutType): string {
  const purposes: Partial<Record<WorkoutType, string>> = {
    intervals: 'Develop maximal aerobic power.',
    threshold: 'Raise the pace you can sustain before lactate accumulates.',
    tempo: 'Build sustained aerobic strength.',
    race_simulation: 'Rehearse goal race pace and effort.',
    strides: 'Maintain leg speed and running mechanics without fatigue.',
    hills: 'Build running-specific strength and power.',
  };
  return purposes[type] ?? 'Quality stimulus.';
}

/** Build a concrete warm-up / main set / cool-down structure. */
function buildQualityStructure(
  type: WorkoutType,
  thresholdPaceSecondsPerKm: number | undefined,
  targetDistanceMeters: number,
): WorkoutStructure | undefined {
  let step = 0;
  const nextId = (): string => `step-${++step}`;

  const warmup = {
    id: nextId(),
    label: 'Warm-up',
    durationSeconds: 600,
    target: { kind: 'zone', zone: 2 } as const,
  };
  const cooldown = {
    id: nextId(),
    label: 'Cool-down',
    durationSeconds: 600,
    target: { kind: 'zone', zone: 1 } as const,
  };

  const thresholdTarget = thresholdPaceSecondsPerKm
    ? ({
        kind: 'pace',
        fastSecondsPerKm: Math.round(thresholdPaceSecondsPerKm * 0.98),
        slowSecondsPerKm: Math.round(thresholdPaceSecondsPerKm * 1.03),
      } as const)
    : ({ kind: 'zone', zone: 4 } as const);

  switch (type) {
    case 'intervals':
      return {
        warmup,
        main: [
          {
            kind: 'repeat',
            repeat: {
              id: nextId(),
              repetitions: 5,
              steps: [
                {
                  id: nextId(),
                  label: '800 m hard',
                  distanceMeters: 800,
                  target: { kind: 'zone', zone: 5 },
                },
                {
                  id: nextId(),
                  label: 'Jog recovery',
                  durationSeconds: 150,
                  target: { kind: 'zone', zone: 1 },
                  isRecovery: true,
                },
              ],
            },
          },
        ],
        cooldown,
      };

    case 'threshold':
      return {
        warmup,
        main: [
          {
            kind: 'repeat',
            repeat: {
              id: nextId(),
              repetitions: 4,
              steps: [
                {
                  id: nextId(),
                  label: '6 min at threshold',
                  durationSeconds: 360,
                  target: thresholdTarget,
                },
                {
                  id: nextId(),
                  label: 'Easy jog',
                  durationSeconds: 120,
                  target: { kind: 'zone', zone: 1 },
                  isRecovery: true,
                },
              ],
            },
          },
        ],
        cooldown,
      };

    case 'tempo':
      return {
        warmup,
        main: [
          {
            kind: 'step',
            step: {
              id: nextId(),
              label: 'Continuous tempo',
              durationSeconds: 20 * 60,
              target: { kind: 'zone', zone: 3 },
            },
          },
        ],
        cooldown,
      };

    case 'strides':
      return {
        warmup,
        main: [
          {
            kind: 'repeat',
            repeat: {
              id: nextId(),
              repetitions: 6,
              steps: [
                {
                  id: nextId(),
                  label: '20 s stride',
                  durationSeconds: 20,
                  target: { kind: 'effort', description: 'Fast but relaxed, not a sprint' },
                },
                {
                  id: nextId(),
                  label: 'Walk back',
                  durationSeconds: 60,
                  target: { kind: 'zone', zone: 1 },
                  isRecovery: true,
                },
              ],
            },
          },
        ],
        cooldown,
      };

    case 'race_simulation':
      return {
        warmup,
        main: [
          {
            kind: 'step',
            step: {
              id: nextId(),
              label: 'At goal race pace',
              distanceMeters: Math.max(3000, Math.round(targetDistanceMeters * 0.6)),
              target: thresholdTarget,
            },
          },
        ],
        cooldown,
      };

    default:
      return undefined;
  }
}

function makeWorkout(args: {
  planId: string;
  block: TrainingBlock;
  date: string;
  type: WorkoutType;
  title: string;
  purpose: string;
  distanceMeters?: number;
  paceRange?: [number, number];
  rpe: number;
  structure?: WorkoutStructure;
  idFactory: (kind: 'plan' | 'block' | 'workout') => string;
}): PlannedWorkout {
  const { paceRange, distanceMeters } = args;

  // Derive a duration estimate from distance and easy pace, so the athlete has
  // a time budget even before any GPS data exists.
  const targetDurationSeconds =
    distanceMeters && paceRange
      ? Math.round((distanceMeters / 1000) * ((paceRange[0] + paceRange[1]) / 2))
      : undefined;

  return {
    id: args.idFactory('workout'),
    planId: args.planId,
    blockId: args.block.id,
    date: args.date,
    type: args.type,
    title: args.title,
    purpose: args.purpose,
    targetDistanceMeters: distanceMeters,
    targetDurationSeconds,
    structure: args.structure,
    targetRpe: args.rpe,
    status: 'planned',
  };
}

/**
 * Weeks between two dates, rounded up — used to size a plan against a race.
 */
export function weeksUntil(fromDate: string, toDate: string): number {
  return Math.max(1, Math.ceil(daysBetweenLocalDates(fromDate, toDate) / 7));
}

/** Locate the athlete's current position within a plan. */
export function findPlanPosition(
  plan: TrainingPlan,
  date: string,
): { block: TrainingBlock; weekInBlock: number; weekInPlan: number; weeklyTargetMeters: number } | undefined {
  const block = plan.blocks.find(
    (b) => daysBetweenLocalDates(b.startDate, date) >= 0 && daysBetweenLocalDates(date, b.endDate) >= 0,
  );
  if (!block) return undefined;

  const weekInBlock = Math.floor(daysBetweenLocalDates(block.startDate, date) / 7) + 1;
  const weekInPlan = Math.floor(daysBetweenLocalDates(plan.startDate, date) / 7) + 1;

  return {
    block,
    weekInBlock,
    weekInPlan,
    weeklyTargetMeters: block.weeklyDistanceTargetsMeters[weekInBlock - 1] ?? 0,
  };
}

/** Day-of-week helper for presentation code. */
export function dayOfWeekForDate(date: string): DayOfWeek {
  return localDayOfWeek(new Date(`${date}T12:00:00Z`), 'UTC') as DayOfWeek;
}
