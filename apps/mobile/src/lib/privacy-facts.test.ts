/**
 * A privacy notice is worth nothing if it is aspirational. These check the
 * copy stays specific — that it names mechanisms rather than sentiments.
 */

import { describe, expect, it } from 'vitest';

import { DEVICE_FACTS, EMPTY_PHRASES, SERVER_FACTS, STORAGE_FACTS } from './privacy-facts';

describe('storage facts', () => {
  it('says something about every place data lives', () => {
    expect(STORAGE_FACTS.some((fact) => fact.location === 'device')).toBe(true);
    expect(STORAGE_FACTS.some((fact) => fact.location === 'server')).toBe(true);
    expect(DEVICE_FACTS.length).toBeGreaterThan(0);
    expect(SERVER_FACTS.length).toBeGreaterThan(0);
  });

  it('contains no phrase that sounds like a commitment and describes nothing', () => {
    const all = STORAGE_FACTS.map((fact) => `${fact.title} ${fact.detail}`)
      .join(' ')
      .toLowerCase();

    for (const phrase of EMPTY_PHRASES) {
      expect(all).not.toContain(phrase);
    }
  });

  it('covers the three things an athlete would ask about', () => {
    const all = STORAGE_FACTS.map((fact) => `${fact.title} ${fact.detail}`)
      .join(' ')
      .toLowerCase();

    // Where photos go, what leaves on sign-out, and what deletion removes.
    expect(all).toContain('photos');
    expect(all).toContain('signing out');
    expect(all).toContain('deleting');
  });

  it('describes the photo-reading data minimisation specifically', () => {
    const reading = STORAGE_FACTS.find((fact) => fact.title.includes('Reading a photo'));

    // Naming what is *not* sent is the substance of the claim.
    expect(reading?.detail).toContain('no name');
    expect(reading?.detail).toContain('no measurements');
    expect(reading?.detail).toContain('read once');
  });

  it('names the mechanism behind account deletion, not just the promise', () => {
    const account = STORAGE_FACTS.find((fact) => fact.title.includes('account'));

    // "Hangs off your athlete profile" is checkable against the schema's
    // cascade; "everything is deleted" is checkable against nothing.
    expect(account?.detail).toContain('profile');
    expect(account?.detail).toContain('cleanup job');
  });

  it('gives every fact a title and a detail worth reading', () => {
    for (const fact of STORAGE_FACTS) {
      expect(fact.title.length).toBeGreaterThan(10);
      // Long enough to describe a mechanism rather than assert a feeling.
      expect(fact.detail.length).toBeGreaterThan(60);
    }
  });
});
