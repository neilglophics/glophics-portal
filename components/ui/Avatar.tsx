import { avatarTone, initials } from "@/lib/shared/tokens";

/**
 * Ported from H.avatar / H.avatarStack.
 *
 * Colour is derived from the id, so a person keeps the same colour everywhere
 * and across reloads without anything being stored. Initials handle the team's
 * "[BE]_Sem" naming, stripping the bracketed prefix first.
 */

export interface AvatarPerson {
  id: string;
  name: string;
}

export function Avatar({
  person,
  size = "h-8 w-8",
  online,
}: {
  person: AvatarPerson;
  size?: string;
  /** Presence dot. Undefined means "presence is not being shown here" — which
   *  is different from "offline", and renders no dot at all. */
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
      <span
        title={person.name}
        className={`grid ${size} shrink-0 place-items-center rounded-full text-[10px] font-bold ring-2 ring-surface ${avatarTone(
          person.id,
        )}`}
      >
        {initials(person.name)}
      </span>
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
