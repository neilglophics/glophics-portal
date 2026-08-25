/**
 * @mentions: how they are stored, parsed and rendered.
 *
 * ── The stored form carries an ID, not a name ──
 *
 * A mention is written into the message body as
 *
 *     @[Display Name](11111111-2222-3333-4444-555555555555)
 *
 * so the link survives a rename: the renderer resolves the id against the
 * conversation's *current* members and paints whatever they are called today. The
 * name inside the token is only a fallback, for somebody who has since left the
 * group or had their login deleted — without it, an old message would read
 * "@Former member" where a name used to be.
 *
 * Storing only `@Display Name`, as the naive version does, breaks the moment
 * anybody is renamed and makes "who was mentioned" unanswerable without
 * re-parsing prose. Storing only the id makes the raw body unreadable in a
 * database console, which is where you look when something has gone wrong.
 *
 * ── Two representations, and never confusing them ──
 *
 *   raw    what is in `chat_messages.body` — contains tokens
 *   plain  what a person sees — "@Display Name"
 *
 * `plainText()` converts raw → plain. Anything that counts, previews or notifies
 * uses plain; only the renderer and the composer see raw. A length limit measured
 * on raw would tell somebody their message is 90 characters over when it looks
 * fine, because a uuid is 36 characters they never typed.
 *
 * Pure and dependency-free: safe to import from a client component, and — like
 * lib/chat/links.ts — it produces SEGMENTS, never HTML. The escaping invariant is
 * untouched.
 */

/** The uuid shape `gen_random_uuid()` produces. Anything else is not one of our ids. */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/**
 * A stored mention token.
 *
 * The name may not contain `]`, which is what keeps this unambiguous without an
 * escaping scheme — `sanitizeMentionName` strips it on the way in.
 */
const TOKEN = new RegExp(`@\\[([^\\]\\n]{1,80})\\]\\((${UUID})\\)`, "g");

/** How long a name may be inside a token. Display names are bounded well below
 *  this; the cap is here so a crafted body cannot carry a paragraph in a token. */
export const MENTION_NAME_MAX = 80;

/**
 * Makes a display name safe to put inside a token.
 *
 * `]` would end the name early and `(`/`)` would confuse the id part, so both go.
 * Newlines go because a token must stay on one line for the regex to be anchored.
 * Replaced rather than dropped, so "Smith] (QA)" stays readable as "Smith (QA)"
 * rather than becoming "Smith QA".
 */
export function sanitizeMentionName(name: string): string {
  const cleaned = name
    .replace(/[\]\[]/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "someone";
  return cleaned.length > MENTION_NAME_MAX ? cleaned.slice(0, MENTION_NAME_MAX) : cleaned;
}

/** Builds the stored form for one mention. */
export function mentionToken(userId: string, displayName: string): string {
  return `@[${sanitizeMentionName(displayName)}](${userId})`;
}

export type BodySegment =
  | { kind: "text"; value: string }
  | { kind: "mention"; userId: string; name: string; raw: string };

/**
 * Splits a raw body into text and mention segments.
 *
 * Like `links.ts segments()`, this exists so the renderer can emit React children
 * rather than markup. Every character of the raw input lands in exactly one
 * segment, so nothing is dropped and nothing is duplicated.
 */
export function mentionSegments(body: string): BodySegment[] {
  const out: BodySegment[] = [];
  let cursor = 0;

  // A fresh regex per call: a shared /g/ one carries `lastIndex` between calls, so
  // the second render of the same string would find nothing.
  const pattern = new RegExp(TOKEN.source, "g");

  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    if (match.index > cursor) {
      out.push({ kind: "text", value: body.slice(cursor, match.index) });
    }
    out.push({
      kind: "mention",
      userId: match[2]!.toLowerCase(),
      name: match[1]!,
      raw: match[0],
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < body.length) {
    out.push({ kind: "text", value: body.slice(cursor) });
  }

  return out;
}

/**
 * The raw body as a person sees it: tokens become "@Name".
 *
 * Used for the length limit, the conversation-list preview, the notification
 * toast and the reply quote — everywhere a body is measured or summarised rather
 * than rendered. Those must never show the raw token, and they must never count
 * a uuid the sender did not type.
 */
export function plainText(body: string): string {
  return mentionSegments(body)
    .map((s) => (s.kind === "mention" ? `@${s.name}` : s.value))
    .join("");
}

/** The ids mentioned in a body, de-duplicated, in order of first appearance. */
export function mentionedIds(body: string): string[] {
  const seen = new Set<string>();
  for (const segment of mentionSegments(body)) {
    if (segment.kind === "mention") seen.add(segment.userId);
  }
  return [...seen];
}

/** Is this person mentioned? Used to decide whether their notification says so. */
export function mentions(body: string, userId: string): boolean {
  return mentionedIds(body).includes(userId.toLowerCase());
}

// ---------- the composer's autocomplete ----------

export interface MentionQuery {
  /** Where the `@` is, so the token can replace from there. */
  start: number;
  /** Where the caret is — the end of what has been typed so far. */
  end: number;
  /** What follows the `@`, for filtering. Empty right after typing `@`. */
  term: string;
}

/**
 * Is the caret inside an `@…` the user is currently typing?
 *
 * Returns null when it is not, which closes the dropdown. The rules, and each one
 * is a case that otherwise misfires:
 *
 *   - the `@` must start a word — at the start of the body or after whitespace —
 *     so an email address does not open a member list on every keystroke;
 *   - the term must contain no whitespace... except that display names have
 *     spaces in them, so up to one space is allowed. "@John S" still searches;
 *     "@John Smith went home" stops searching once it is clearly prose;
 *   - the term is capped, so a paragraph typed after a stray `@` is not treated
 *     as a search.
 */
export function mentionQueryAt(body: string, caret: number): MentionQuery | null {
  // Scan back from the caret for the nearest '@' that could start a mention.
  for (let i = caret - 1; i >= 0 && caret - i <= 40; i -= 1) {
    const char = body[i]!;

    if (char === "@") {
      const before = i === 0 ? "" : body[i - 1]!;
      // Must begin a word. `foo@bar` is an email, not a mention.
      if (before && !/\s/.test(before)) return null;

      const term = body.slice(i + 1, caret);
      // A newline always ends it, and so does a second space — one is allowed so
      // that "First Last" can be searched.
      if (/\n/.test(term)) return null;
      if ((term.match(/ /g) ?? []).length > 1) return null;

      return { start: i, end: caret, term };
    }

    // A newline between the caret and any '@' means we are not in one.
    if (char === "\n") return null;
  }

  return null;
}

// ---------- the composer's draft ----------

/**
 * A mention in the text somebody is currently typing.
 *
 * ── The composer holds PLAIN text, not tokens ──
 *
 * This is the whole reason these functions exist. The composer is a `<textarea>`,
 * so whatever is in it is what the person sees — and putting the stored form there
 * meant they watched `@[Super Admin](257e27db-358a-…)` appear as they typed. The
 * uuid is for the database; nobody should ever be shown it.
 *
 * So the draft reads `@Super Admin`, and these ranges remember which spans of it
 * are really mentions. `serializeMentions` turns them into tokens at send time.
 *
 * The alternative — a contenteditable with real chips — is what a bigger app
 * would build, and it brings paste handling, caret management and mobile IME
 * problems with it. A plain textarea plus a range list keeps all of that away for
 * a feature this size.
 */
export interface DraftMention {
  /** Index of the `@`. */
  start: number;
  /** Exclusive end, just past the last character of the name. */
  end: number;
  userId: string;
  name: string;
}

/**
 * Inserts `@Name ` in place of the `@…` being typed, and records the range.
 *
 * Returns where the caret should go, because the composer has to put it back:
 * setting a textarea's value drops the cursor at the end, which is wrong for
 * anybody mentioning somebody mid-sentence.
 *
 * A trailing space so the next word is not glued to the mention — and it is
 * deliberately OUTSIDE the recorded range, so typing after the mention does not
 * count as editing it.
 */
export function insertMention(
  text: string,
  mentions: readonly DraftMention[],
  query: MentionQuery,
  user: { id: string; displayName: string },
): { text: string; mentions: DraftMention[]; caret: number } {
  const name = sanitizeMentionName(user.displayName);
  const inserted = `@${name} `;
  const next = text.slice(0, query.start) + inserted + text.slice(query.end);

  // Everything after the replaced span moves by this much.
  const delta = inserted.length - (query.end - query.start);

  const shifted = mentions
    // Anything overlapping the span being replaced is gone — the query cannot
    // overlap a completed mention in practice, but shifting a range that no
    // longer exists is how ranges go stale.
    .filter((m) => m.end <= query.start || m.start >= query.end)
    .map((m) => (m.start >= query.end ? { ...m, start: m.start + delta, end: m.end + delta } : m));

  return {
    text: next,
    mentions: [
      ...shifted,
      // The range covers "@Name" and not the trailing space.
      { start: query.start, end: query.start + 1 + name.length, userId: user.id, name },
    ].sort((a, b) => a.start - b.start),
    caret: query.start + inserted.length,
  };
}

/**
 * Moves the recorded ranges to keep up with an edit somewhere in the text.
 *
 * ── Why a diff and not a change event ──
 *
 * A textarea reports the new value, not what changed. Comparing the common prefix
 * and suffix locates the edited span exactly, which is enough for all three cases
 * that matter, and it works for a paste, a multi-character delete and an
 * autocorrect substitution alike:
 *
 *   before the mention   shift it by the length delta
 *   after the mention    leave it alone
 *   INSIDE the mention   drop it
 *
 * That last one is the important one. Somebody backspacing into "@Super Admin"
 * clearly no longer means the mention — the remaining text stops being a link, and
 * the message sends "@Super Admi" as ordinary words. Keeping the range would
 * send a mention whose visible text does not match the person it points at.
 */
export function adjustMentions(
  mentions: readonly DraftMention[],
  before: string,
  after: string,
): DraftMention[] {
  if (before === after || !mentions.length) return [...mentions];

  // Longest common prefix.
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  // Longest common suffix, not overlapping the prefix.
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  // The edited span in the OLD text, and how much longer the text got.
  const changedStart = prefix;
  const changedEnd = before.length - suffix;
  const delta = after.length - before.length;

  /**
   * Does an edit landing exactly at a mention's end EXTEND its name?
   *
   * The boundary is genuinely ambiguous and the answer depends on what arrived:
   *
   *   "@Alex" + "x"       → "@Alexx"      the name grew; this is no longer a
   *                                        mention of Alex
   *   "@Alex" + " there"  → "@Alex there"  the mention is intact and somebody is
   *                                        typing after it
   *   "@Alex " − " "      → "@Alex"        a deletion; the name is untouched
   *
   * So: only a pure insertion whose first character could be part of a name
   * counts as extending it. Whitespace, punctuation and deletions do not.
   */
  const inserted = changedEnd === changedStart ? after.slice(changedStart, changedStart + delta) : "";
  const extendsName = inserted.length > 0 && !/^[\s.,;:!?]/.test(inserted);

  const out: DraftMention[] = [];
  for (const mention of mentions) {
    // Entirely before the edit — or touching it, when the edit does not extend
    // the name. See `extendsName`.
    if (mention.end < changedStart || (mention.end === changedStart && !extendsName)) {
      out.push(mention);
      continue;
    }
    // Entirely after it — including an insert at exactly the `@`, which pushes
    // the whole mention right rather than absorbing the new text.
    if (mention.start >= changedEnd) {
      out.push({ ...mention, start: mention.start + delta, end: mention.end + delta });
      continue;
    }
    // Overlapping — the name itself was edited, so it is no longer a mention.
  }

  return out;
}

/**
 * Turns the plain draft into the body that gets stored.
 *
 * Applied right-to-left so each replacement cannot move the ranges that have not
 * been used yet — the classic off-by-everything bug when rewriting several spans
 * of one string.
 *
 * A range whose text no longer reads as `@Name` is skipped rather than trusted.
 * `adjustMentions` should already have dropped it, and this is the second net: a
 * token is a claim about who is being addressed, and it must never be generated
 * from text that says something else.
 */
export function serializeMentions(text: string, mentions: readonly DraftMention[]): string {
  let out = text;

  for (const mention of [...mentions].sort((a, b) => b.start - a.start)) {
    if (mention.start < 0 || mention.end > out.length) continue;
    if (out.slice(mention.start, mention.end) !== `@${mention.name}`) continue;

    out = out.slice(0, mention.start) + mentionToken(mention.userId, mention.name) + out.slice(mention.end);
  }

  return out;
}

/**
 * Filters candidates for the dropdown.
 *
 * Matches on display name and username, because people reach for either. Ranked
 * so a prefix match beats a match in the middle — typing "ja" should offer "Jan"
 * before "Sanjay".
 */
export function filterMentionCandidates<T extends { displayName: string; username?: string }>(
  candidates: readonly T[],
  term: string,
  limit = 8,
): T[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return candidates.slice(0, limit);

  const scored: { item: T; score: number }[] = [];

  for (const item of candidates) {
    const name = item.displayName.toLowerCase();
    const username = (item.username ?? "").toLowerCase();

    // 0 = best. A name prefix beats a username prefix beats anything internal.
    if (name.startsWith(needle)) scored.push({ item, score: 0 });
    else if (username.startsWith(needle)) scored.push({ item, score: 1 });
    else if (name.includes(needle)) scored.push({ item, score: 2 });
    else if (username.includes(needle)) scored.push({ item, score: 3 });
    // A last-name match: "smith" should find "John Smith".
    else if (name.split(/\s+/).some((part) => part.startsWith(needle))) scored.push({ item, score: 2 });
  }

  return scored
    // Stable within a score band, so the list does not reshuffle as somebody
    // types a character that does not change the ranking.
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((s) => s.item);
}
