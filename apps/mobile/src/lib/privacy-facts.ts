/**
 * What actually happens to composition data.
 *
 * Every statement here describes something the code does. That constraint is
 * the whole point: a privacy page is worth nothing if it is aspirational, and
 * the fastest way for one to become false is for it to be written once, in
 * marketing language, and never checked against the system again.
 *
 * So the facts live in a module next to the code they describe, each one
 * naming a specific mechanism rather than a sentiment. "Photos are stored under
 * keys the server generates" can be checked against the storage service.
 * "We take your privacy seriously" cannot be checked against anything.
 */

export interface PrivacyFact {
  /** What this is about, in the athlete's terms. */
  title: string;
  /** What happens. Specific enough to be wrong if the code changed. */
  detail: string;
  /** Where the thing lives. */
  location: 'device' | 'server' | 'both';
}

export const STORAGE_FACTS: readonly PrivacyFact[] = [
  {
    title: 'Your photos are held on our servers',
    detail:
      'They have to be: reading them and comparing two sessions both happen there. They are stored under keys our server generates, never a path your phone chooses, and they are only ever served back to you through a signed-in request.',
    location: 'server',
  },
  {
    title: 'Your measurements are held on our servers too',
    detail:
      'Numbers, dates and which measure point each belongs to. They sync so that signing in on another device shows the same history.',
    location: 'server',
  },
  {
    title: 'The app talks to our servers over HTTPS',
    detail:
      'Photos and measurements are encrypted in transit, and your photos are encrypted again on the server disk rather than sitting there as ordinary image files. Your sign-in token is kept in the device keychain, not in ordinary app storage.',
    location: 'both',
  },
  {
    title: 'Reading a photo sends the image and nothing else',
    detail:
      'When you ask for an estimate from your photos, the images go to the reading service on their own — no name, no account id, no measurements, no training history. Each session is read once; asking again returns the answer already held.',
    location: 'server',
  },
  {
    title: 'Signing out clears this device',
    detail:
      'Your token, the cached copies of anything the app downloaded, and your measurement-unit preference are all removed. Nothing about your body is left on the phone for whoever uses it next.',
    location: 'device',
  },
  {
    title: 'Signing out also ends the session on our side',
    detail:
      'We stop accepting every token your account has been given, not just the one on this phone, so a copy taken from somewhere else cannot keep reading your photos. Nothing is deleted: your sessions and measurements come back when you sign in again.',
    location: 'server',
  },
  {
    title: 'Deleting a session deletes all of it',
    detail:
      'The photos, the measurements, and any body fat estimate worked out from them go together, on the server as well as here. Your other sessions are untouched.',
    location: 'both',
  },
  {
    title: 'Deleting your account deletes everything',
    detail:
      'Composition data hangs off your athlete profile in the database, so removing the account removes every session, photo and measurement with it in one operation rather than relying on a cleanup job.',
    location: 'both',
  },
];

/** Facts about what is kept on the phone itself. */
export const DEVICE_FACTS = STORAGE_FACTS.filter(
  (fact) => fact.location === 'device' || fact.location === 'both',
);

/** Facts about what is kept on the server. */
export const SERVER_FACTS = STORAGE_FACTS.filter(
  (fact) => fact.location === 'server' || fact.location === 'both',
);

/**
 * Words that mean nothing in a privacy notice.
 *
 * Exported so a test can assert they are absent. Each one is a phrase that
 * sounds like a commitment and describes no mechanism, which is exactly the
 * kind of sentence this module exists to keep out.
 */
export const EMPTY_PHRASES: readonly string[] = [
  'take your privacy seriously',
  'industry standard',
  'bank-level',
  'military-grade',
  'state of the art',
  'rest assured',
  'utmost care',
  'peace of mind',
];
