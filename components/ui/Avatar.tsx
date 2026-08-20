import { avatarTone, initials } from "@/lib/shared/tokens";

/**
 * Ported from H.avatar / H.avatarStack, now with an optional uploaded image.
 *
 * Initials remain the default, not a fallback for a failed load: most of the
 * board has no login, and only a login can upload a picture. Colour is derived
 * from the id so a person keeps the same one everywhere and across reloads
 * without anything being stored.
 */

export interface AvatarPerson {
  id: string;
  name: string;
  /** From lib/db/queries/avatars.ts avatarUrl(). Carries a ?v= version, so it
   *  can be cached hard and still update the moment somebody re-uploads. */
  avatarUrl?: string | null;
}

export function Avatar({
  person,
  size = "h-8 w-8",
  online,
}: {
  person: AvatarPerson;
  size?: string;
  /** Presence dot. Undefined means "presence is not shown here" — which is
   *  different from "offline", and renders no dot at all. */
  online?: boolean;
}) {
  const badge =
    online === undefined ? null : (
      <span
        title={online ? "Online" : "Offline"}
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${
          online ? "bg-ok" : "bg-faintest"
        }`}
      />
    );

  return (
    <span className="relative inline-flex shrink-0">
      {person.avatarUrl ? (
        // A plain <img>, not next/image: these are already optimised to a
        // 256px WebP on the way in, and next/image would put its own loader in
        // front of an authenticated route for no benefit.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={person.avatarUrl}
          alt={person.name}
          title={person.name}
          loading="lazy"
          decoding="async"
          className={`${size} shrink-0 rounded-full object-cover ring-2 ring-surface`}
        />
      ) : (
        <span
          title={person.name}
          className={`grid ${size} shrink-0 place-items-center rounded-full text-[10px] font-bold ring-2 ring-surface ${avatarTone(
            person.id,
          )}`}
        >
          {initials(person.name)}
        </span>
      )}
      {badge}
    </span>
  );
}

export function AvatarStack({ people, max = 3 }: { people: AvatarPerson[]; max?: number }) {
  if (!people.length) return <span className="text-sm text-faintest">—</span>;

  const shown = people.slice(0, max);
  const rest = people.length - shown.length;

  return (
    <div className="flex items-center">
      <div className="flex -space-x-2">
        {shown.map((person) => (
          <Avatar key={person.id} person={person} />
        ))}
      </div>
      {rest > 0 && <span className="ml-2.5 text-[11px] font-semibold text-faint">+{rest}</span>}
    </div>
  );
}
