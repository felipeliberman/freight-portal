// THE REFUSAL VOCABULARY — one set, agreed before the controls were written rather than grown
// case by case inside them (spec §8.872).
//
// ── REFUSALS AND THROWS ARE DIFFERENT CATEGORIES. Keep them apart. ───────────────────────────
//
// A REFUSAL is an EXPECTED OUTCOME that a caller handles: the customer is not resolved yet, the
// row is outside the pilot bound, another run is mid-create. Every one of these is a normal state
// of a correct system, and the caller's job is to skip and move on.
//
// A THROW is a BROKEN INVARIANT that nobody should be handling. `assertLivemode` throwing on a
// mode mismatch is the example: a caller able to write `if (!result.ok)` past it is a caller that
// can ignore it, and the whole point is that it cannot be ignored. Same for an unknown
// `stripe_state`, and for a claim outside the bound (which means a caller skipped the poll's
// filter — a programming error, not a business condition).
//
// The temptation runs one way: the next refusal will look throwable, or the next broken invariant
// will look like it deserves a nice `{ok:false}`. Neither. Ask whether a correct system reaches
// this state on an ordinary Tuesday. If yes it is a refusal; if no it is a throw.
//
// ── SHAPE ────────────────────────────────────────────────────────────────────────────────────
//
// Always `{ ok: false, reason: <one of REFUSAL_REASONS> }`, optionally with `detail`. NEVER a bare
// `false`, never a thrown string. A caller that has to string-match an error to understand it is
// not looking at an API.

/**
 * Every legal refusal reason. ONE set, imported rather than remembered — the same discipline as
 * STRIPE_STATES, and for the same reason: a coined synonym is how a vocabulary stops being one.
 */
export const REFUSAL_REASONS = Object.freeze({
  /**
   * The ARCode is outside AR_ALLOWLIST (control 8).
   *
   * DELIBERATELY THE SAME STRING checkArCode already returns for this exact condition
   * (config.js). A second name for one condition is how five different words for "this ARCode did
   * not work out" came to exist across four layers.
   */
  NOT_ALLOWLISTED: 'not_allowlisted',

  /** The (mode, ar_code) join yields no usable Stripe customer id (control 9). */
  NO_STRIPE_CUSTOMER: 'no_stripe_customer',

  /**
   * This row is in `creating` — a create was attempted and its outcome is unknown (control 7).
   * Stripe must be READ before anything else is created, or the unknown becomes a duplicate.
   */
  CREATE_IN_FLIGHT: 'create_in_flight',

  /** The row already carries a Stripe id; there is nothing to create (control 1's negative side). */
  ALREADY_MATERIALIZED: 'already_materialized',

  /**
   * A DIFFERENT ledger row already holds this Stripe INVOICE id (control 6).
   *
   * The sibling of CUSTOMER_ID_ALREADY_CLAIMED, on the other table. Both tables must handle an
   * identical condition by an identical philosophy — a caller that learns one convention has to be
   * able to rely on it, which is the entire point of having a vocabulary rather than a habit.
   */
  INVOICE_ID_ALREADY_CLAIMED: 'invoice_id_already_claimed',

  /**
   * A DIFFERENT row already holds this Stripe customer id (control 5).
   *
   * The worst refusal in the set: unrefused it would bill one company's freight to another. It is
   * expected — it is precisely what the partial unique index exists to produce — so it belongs
   * here rather than escaping as a raw storage-engine error.
   */
  CUSTOMER_ID_ALREADY_CLAIMED: 'customer_id_already_claimed',

  // ── recipient resolution (src/recipient.js) ────────────────────────────────────────────────
  //
  // THREE reasons, not one, because each names a DIFFERENT thing for a human to go and do. A
  // single `bad_recipient` would put "nobody filled the field in", "somebody typo'd it" and "the
  // record is in a state we refuse to interpret" into one bucket, and the exception queue exists
  // precisely so that someone can act without a reconstruction.

  /** The selected source is empty. Nowhere to deliver. Action: fill the field in on the console. */
  NO_RECIPIENT: 'no_recipient',

  /**
   * The selected source HAD content and none of it survived parsing — `ap@paylessrugs` with no
   * TLD, a bare name, a stray "see attached". Action: fix the value.
   *
   * Distinct from NO_RECIPIENT on purpose: an empty field and a malformed one look identical
   * downstream, and the malformed one is the more urgent because somebody believed they had
   * entered an address.
   */
  RECIPIENT_UNPARSEABLE: 'recipient_unparseable',

  /**
   * `remitToSL` is neither '1' nor '0', so WHICH field is authoritative cannot be determined.
   *
   * Refused rather than defaulted, in either direction. Defaulting to the billing address would
   * email AP on a record whose console screen says "same as shipping"; defaulting to main would
   * ignore an override that exists. Both are silent, both are wrong, and neither is detectable
   * from the outside — the delivered email looks perfect either way.
   */
  RECIPIENT_SOURCE_UNKNOWN: 'recipient_source_unknown',

  /**
   * The customer record could not be READ — the console is unreachable, returned a non-200, or the
   * session could not be established (src/console-session.js).
   *
   * A REFUSAL rather than a throw, by this file's own test: a shared production console being down
   * on an ordinary Tuesday is a normal state of a correct system, and the caller's job is to skip
   * the invoice and move on.
   *
   * TRANSIENT BY CONSTRUCTION. The send candidate rule is `first_sent_at IS NULL`, so an invoice
   * refused here is simply re-selected on the next run. Nothing may be written that consumes it —
   * a console outage must not turn into an invoice nobody ever sends.
   */
  RECIPIENT_LOOKUP_FAILED: 'recipient_lookup_failed',

  /**
   * The console ANSWERED, and what came back is not a customer record (src/console-lookup.js).
   *
   * DELIBERATELY DISTINCT from RECIPIENT_LOOKUP_FAILED, which means the console did not answer.
   * The two send a human to different places: an outage is "wait, or page whoever owns the
   * console", and this is "read the response, something upstream changed shape". Collapsing them
   * would have someone reading JSON that was never returned.
   *
   * `detail.reason` narrows it further — `no_record` (the console's own "No results.", which
   * arrives as `data: []` with success "true"), `id_missing`, `id_mismatch`,
   * `accounting_contacts_absent`. All four are refused rather than read as an empty record,
   * because every one of them is success-shaped.
   */
  RECIPIENT_RECORD_UNRECOGNISED: 'recipient_record_unrecognised',
});

const ALL = Object.freeze(new Set(Object.values(REFUSAL_REASONS)));

/**
 * Build a refusal. Validates the reason against the set, so a typo cannot invent a sixth word.
 *
 * @param {string} reason  one of REFUSAL_REASONS
 * @param {object} [detail] short, non-sensitive context — never a Primus detail object (§6.1)
 */
export function refuse(reason, detail = undefined) {
  if (!ALL.has(reason)) {
    throw new Error(
      `Unknown refusal reason ${JSON.stringify(reason)} — expected one of ${[...ALL].join(', ')}. ` +
      `The set is agreed up front (spec §8.872); growing it case by case is how it stops being a set.`
    );
  }
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/** The success counterpart, so callers test one shape rather than two. */
export function allow(value = undefined) {
  return value === undefined ? { ok: true } : { ok: true, value };
}
