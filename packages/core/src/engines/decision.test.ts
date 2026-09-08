import { describe, expect, it } from 'vitest';
import { decideToday, type DecisionInputs } from './decision.js';
import type { PlannedWorkout } from '../domain/workout.js';
import type { RecoveryState } from '../domain/recovery.js';
import type { TrainingStateAssessment } from '../domain/coaching.js';

const DATE = '2026-08-18';

function makePlanned(overrides: Partial<PlannedWorkout> = {}): PlannedWorkout {
  return {
    id: 'pw-1',
    planId: 'plan-1',
    blockId: 'block-1',
    date: DATE,
    type: 'intervals',
    title: '5 × 800 m',
    purpose: 'VO₂max development',
    targetDistanceMeters: 9000,
    targetDurationSeconds: 3300,
    targetRpe: 8,
    status: 'planned',
    ...overrides,
  };
}

function makeRecovery(overrides: Partial<RecoveryState> = {}): RecoveryState {
  return {
    athleteId: 'athlete-1',
    date: DATE,
    score: 78,
    band: 'green',
    components: [],
    missingSignals: [],
    dataCompleteness: 0.9,
    summary: '',
    ...overrides,
  };
}

function makeState(overrides: Partial<TrainingStateAssessment> = {}): TrainingStateAssessment {
  return {
    state: 'normal',
    confidence: 0.7,
    signals: [],
    summary: '',
    recommendProfessionalReview: false,
    ...overrides,
  };
}

function baseInputs(overrides: Partial<DecisionInputs> = {}): DecisionInputs {
  let counter = 0;
  return {
    athleteId: 'athlete-1',
    date: DATE,
    plannedWorkout: makePlanned(),
    recovery: makeRecovery(),
    trainingState: makeState(),
    idFactory: () => `decision-${++counter}`,
    now: new Date('2026-08-18T00:00:00Z'),
    ...overrides,
  };
}

describe('safety overrides everything', () => {
  it('recommends rest when the athlete reports pain, even with perfect recovery', () => {
    const decision = decideToday(
      baseInputs({
        recovery: makeRecovery({ score: 95, band: 'green' }),
        checkIn: {
          id: 'c-1',
          athleteId: 'athlete-1',
          date: DATE,
          energy: 5,
          soreness: 5,
          stress: 5,
          motivation: 5,
          hasPain: true,
          createdAt: new Date('2026-08-18T00:00:00Z'),
          painNote: 'Left achilles',
        },
      }),
    );

    expect(decision.decision).toBe('REST');
    expect(decision.reasons.some((r) => r.key === 'reported_pain')).toBe(true);
  });

  it('points to professional evaluation rather than diagnosing the pain', () => {
    const decision = decideToday(
      baseInputs({
        checkIn: {
          id: 'c-1',
          athleteId: 'athlete-1',
          date: DATE,
          energy: 3,
          soreness: 2,
          stress: 3,
          motivation: 3,
          hasPain: true,
          createdAt: new Date('2026-08-18T00:00:00Z'),
        },
      }),
    );

    expect(decision.explanation).toMatch(/qualified health professional/i);
    expect(decision.explanation).toMatch(/does not diagnose/i);
  });
});

describe('good recovery', () => {
  it('runs the session as planned', () => {
    const decision = decideToday(baseInputs());
    expect(decision.decision).toBe('RUN_AS_PLANNED');
    expect(decision.recommendedPlan).toBeUndefined();
  });

  it('explains why nothing changed', () => {
    const decision = decideToday(baseInputs());
    expect(decision.explanation).toMatch(/stays as planned/i);
  });
});

describe('poor recovery', () => {
  it('replaces a hard session with an easy run', () => {
    const decision = decideToday(
      baseInputs({
        recovery: makeRecovery({ score: 28, band: 'red' }),
        trainingState: makeState({ state: 'fatigued' }),
      }),
    );

    expect(['CHANGE_TO_EASY_RUN', 'REST', 'CHANGE_TO_RECOVERY_RUN']).toContain(decision.decision);
    expect(decision.recommendedPlan).toBeDefined();
    expect(decision.recommendedPlan!.type).not.toBe('intervals');
  });

  it('records what the session was changed from', () => {
    const decision = decideToday(
      baseInputs({
        recovery: makeRecovery({ score: 25, band: 'red' }),
        trainingState: makeState({ state: 'highly_fatigued' }),
      }),
    );

    expect(decision.recommendedPlan!.modifiedFrom).toBeDefined();
    expect(decision.recommendedPlan!.modifiedFrom!.type).toBe('intervals');
    expect(decision.recommendedPlan!.status).toBe('modified');
  });

  it('shortens rather than cancels a long run', () => {
    const decision = decideToday(
      baseInputs({
        plannedWorkout: makePlanned({
          type: 'long',
          title: 'Long run',
          targetDistanceMeters: 20000,
          targetDurationSeconds: 7200,
        }),
        recovery: makeRecovery({ score: 30, band: 'red' }),
        trainingState: makeState({ state: 'fatigued' }),
      }),
    );

    expect(decision.decision).toBe('SHORTEN_LONG_RUN');
    expect(decision.recommendedPlan!.targetDistanceMeters).toBeLessThan(20000);
    expect(decision.recommendedPlan!.targetDistanceMeters).toBeGreaterThan(0);
  });
});

describe('hard-day spacing', () => {
  it('backs off when a hard session was completed yesterday', () => {
    const decision = decideToday(
      baseInputs({
        recovery: makeRecovery({ score: 60, band: 'yellow' }),
        recentHardSessionDates: ['2026-08-17'],
      }),
    );

    expect(decision.decision).not.toBe('RUN_AS_PLANNED');
    expect(decision.reasons.some((r) => r.key === 'hard_session_spacing')).toBe(true);
  });

  it('ignores hard-day spacing when today is an easy run', () => {
    const decision = decideToday(
      baseInputs({
        plannedWorkout: makePlanned({ type: 'easy', title: 'Easy run', targetRpe: 3 }),
        recentHardSessionDates: ['2026-08-17'],
      }),
    );

    expect(decision.reasons.some((r) => r.key === 'hard_session_spacing')).toBe(false);
  });

  it('flags too many hard sessions in a week', () => {
    const decision = decideToday(
      baseInputs({
        recentHardSessionDates: ['2026-08-16', '2026-08-14', '2026-08-12'],
      }),
    );
    expect(decision.reasons.some((r) => r.key === 'hard_session_density')).toBe(true);
  });
});

describe('race proximity', () => {
  it('reduces intensity in the last two days before a race', () => {
    const decision = decideToday(
      baseInputs({ daysUntilRace: 1, recovery: makeRecovery({ score: 90, band: 'green' }) }),
    );
    expect(decision.decision).toBe('REDUCE_INTENSITY');
    expect(decision.reasons.some((r) => r.key === 'race_imminent')).toBe(true);
  });
});

describe('rest days and empty plans', () => {
  it('handles a scheduled rest day', () => {
    const decision = decideToday(
      baseInputs({ plannedWorkout: makePlanned({ type: 'rest', title: 'Rest' }) }),
    );
    expect(decision.decision).toBe('RUN_AS_PLANNED');
    expect(decision.headline).toBe('Rest day');
  });

  it('handles having no plan at all', () => {
    const decision = decideToday(baseInputs({ plannedWorkout: undefined }));
    expect(decision.decision).toBe('RUN_AS_PLANNED');
    expect(decision.headline).toMatch(/Nothing scheduled/i);
  });
});

describe('explainability contract', () => {
  it('every decision carries at least one reason', () => {
    const scenarios: DecisionInputs[] = [
      baseInputs(),
      baseInputs({ recovery: makeRecovery({ score: 20, band: 'red' }) }),
      baseInputs({ daysUntilRace: 1 }),
      baseInputs({ plannedWorkout: makePlanned({ type: 'rest' }) }),
    ];

    for (const scenario of scenarios) {
      const decision = decideToday(scenario);
      expect(decision.reasons.length).toBeGreaterThan(0);
      expect(decision.explanation.length).toBeGreaterThan(10);
      expect(decision.headline.length).toBeGreaterThan(0);
    }
  });

  it('sorts reasons by significance', () => {
    const decision = decideToday(
      baseInputs({
        recovery: makeRecovery({ score: 25, band: 'red' }),
        recentHardSessionDates: ['2026-08-17'],
        trainingState: makeState({ state: 'overreaching_risk' }),
      }),
    );

    for (let i = 1; i < decision.reasons.length; i++) {
      expect(Math.abs(decision.reasons[i - 1]!.weight)).toBeGreaterThanOrEqual(
        Math.abs(decision.reasons[i]!.weight),
      );
    }
  });

  it('produces a confidence value in range', () => {
    const decision = decideToday(baseInputs());
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
  });

  it('lowers confidence when recovery data coverage is poor', () => {
    const rich = decideToday(
      baseInputs({ recovery: makeRecovery({ score: 30, band: 'red', dataCompleteness: 0.95 }) }),
    );
    const sparse = decideToday(
      baseInputs({ recovery: makeRecovery({ score: 30, band: 'red', dataCompleteness: 0.2 }) }),
    );
    expect(sparse.confidence).toBeLessThan(rich.confidence);
  });
});

describe('determinism', () => {
  it('produces the same decision for the same inputs', () => {
    const a = decideToday(baseInputs({ recovery: makeRecovery({ score: 42, band: 'yellow' }) }));
    const b = decideToday(baseInputs({ recovery: makeRecovery({ score: 42, band: 'yellow' }) }));

    expect(a.decision).toBe(b.decision);
    expect(a.confidence).toBe(b.confidence);
    expect(a.reasons.map((r) => r.key)).toEqual(b.reasons.map((r) => r.key));
  });
});
