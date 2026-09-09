/**
 * @running/core — domain model and performance engines.
 *
 * Pure TypeScript with zero runtime dependencies. Everything here is
 * deterministic and side-effect free: no I/O, no clocks read implicitly, no
 * randomness. Callers inject ids and timestamps. That is what makes the
 * coaching logic testable and its output reproducible.
 */

// --- Domain ---------------------------------------------------------------
export * from './domain/athlete.js';
export * from './domain/body-composition.js';
export * from './domain/coaching.js';
export * from './domain/provenance.js';
export * from './domain/race.js';
export * from './domain/recovery.js';
export * from './domain/training.js';
export * from './domain/workout.js';

// --- Engines --------------------------------------------------------------
export * from './engines/decision.js';
export * from './engines/dedup.js';
export * from './engines/efficiency.js';
export * from './engines/fitness.js';
export * from './engines/load.js';
export * from './engines/planner.js';
export * from './engines/race.js';
export * from './engines/recovery.js';
export * from './engines/review.js';
export * from './engines/state.js';
export * from './engines/trends.js';
export * from './engines/zones.js';

// --- Units and utilities --------------------------------------------------
export * from './units/index.js';
export * from './util/stats.js';
export * from './util/time.js';
