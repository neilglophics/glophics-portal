-- 0004_chat_reactions_and_groups — reactions on messages, and real group chat.
--
-- Both features EXTEND what 0001_init already laid down rather than replacing it.
-- `chat_conversations.kind` has said 'dm' | 'group' from the start and
-- `chat_members.member_role` has always existed; what was missing was the
-- admin tier, a group's own avatar and updated_at, and a place to put reactions.
-- Nothing here alters the DM path, so existing direct messages keep behaving
-- exactly as they did.

-- ============================================================
-- Reactions
-- ============================================================

-- One row per (message, person, emoji).
--
-- THE PRIMARY KEY IS THE DUPLICATE PREVENTION. Not a check in application code —
-- two taps racing each other would both pass such a check and both insert. With
-- this key the second insert is refused by the database, which is why the toggle
-- in lib/db/queries/chat.ts can be a single statement with no read-then-write
-- window in it.
--
-- A person may hold SEVERAL different emoji on the same message (👍 and 🎉), the
-- way Slack and Discord work — the key is (message, user, emoji), not
-- (message, user). "Changing" a reaction is therefore removing one and adding
-- another, which is what the two taps it takes already express.
CREATE TABLE chat_message_reactions (
  message_id bigint      NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  -- CASCADE, unlike chat_messages.sender_id which is SET NULL: a message from a
  -- former member still reads as a message, but a reaction with nobody behind it
  -- is just a number nobody can account for.
  user_id    uuid        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  emoji      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (message_id, user_id, emoji),

  -- A length bound, deliberately NOT a CHECK listing the allowed emoji.
  --
  -- The allowlist lives in lib/chat/reactions.ts, because it is read by the
  -- picker in the browser AND enforced by the route handler — the same "one
  -- list, enforced twice" shape as AUTH_ROLES. Encoding it here too would mean a
  -- migration every time somebody wants 🤔, and three places to keep in step
  -- instead of one. This constraint is the backstop that stops a bug from
  -- writing an essay into the column.
  --
  -- 32 rather than 4: a single grapheme with a ZWJ sequence and a skin-tone
  -- modifier is comfortably longer than one code point.
  CONSTRAINT chat_message_reactions_emoji_sane
    CHECK (length(emoji) BETWEEN 1 AND 32)
);

-- Every read is "the reactions on these messages", so this is the only index
-- that matters. The primary key already covers the per-user lookups.
CREATE INDEX chat_message_reactions_message_idx
  ON chat_message_reactions (message_id);

-- ============================================================
-- Groups
-- ============================================================

-- Rename, avatar change and membership change are all edits to the group that do
-- NOT bump last_message_at (they are not messages), so the conversation needs a
-- second timestamp of its own.
ALTER TABLE chat_conversations
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- 'admin' is new. 0001 allowed only owner and member, which left no way to hand
-- somebody the ability to manage the group without handing them the group.
--
-- Dropped and re-added rather than edited: a CHECK cannot be altered in place,
-- and re-adding it re-validates the existing rows, which is the point — if any
-- row already held something outside this list this migration should fail here
-- rather than leave the constraint quietly wider than it reads.
ALTER TABLE chat_members
  DROP CONSTRAINT chat_members_role_valid;

ALTER TABLE chat_members
  ADD CONSTRAINT chat_members_role_valid
    CHECK (member_role IN ('owner', 'admin', 'member'));

-- Exactly one owner per conversation. A group with two owners has an
-- unanswerable question in it ("who can demote whom"), and a group with none
-- cannot be administered at all — leaveGroup() transfers the title precisely so
-- this stays true.
--
-- Scoped to owners with a partial index rather than a table constraint, because
-- members and admins are of course many per conversation.
CREATE UNIQUE INDEX chat_members_one_owner_idx
  ON chat_members (conversation_id) WHERE member_role = 'owner';

-- A group's picture.
--
-- Deliberately the same shape as auth_user_avatars — same column names, same
-- constraints, same reasoning (see 0003_avatars.sql: bytes in Postgres, in their
-- own table, served by a route that can check who is asking). A group avatar is
-- visible to its members and nobody else, which a Blob capability URL could not
-- express.
--
-- Not a column on chat_conversations for the same reason it is not one on
-- auth_users: that row is read by every conversation-list query in the app.
CREATE TABLE chat_conversation_avatars (
  conversation_id uuid        PRIMARY KEY REFERENCES chat_conversations(id) ON DELETE CASCADE,
  bytes           bytea       NOT NULL,
  mime            text        NOT NULL,
  width           integer     NOT NULL,
  height          integer     NOT NULL,
  byte_size       integer     NOT NULL,
  -- The cache-busting token in the image URL.
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chat_conversation_avatars_mime_valid
    CHECK (mime IN ('image/webp', 'image/avif', 'image/jpeg', 'image/png')),

  CONSTRAINT chat_conversation_avatars_size_sane
    CHECK (byte_size > 0 AND byte_size <= 512 * 1024),

  CONSTRAINT chat_conversation_avatars_dimensions_sane
    CHECK (width BETWEEN 1 AND 1024 AND height BETWEEN 1 AND 1024)
);

-- ============================================================
-- System messages
-- ============================================================

-- "Alex added Jamie", "Jamie left the group", "Alex changed the group name".
--
-- These are stored as ordinary rows in chat_messages with kind = 'system', which
-- 0001's CHECK has always allowed. That is the whole trick: they inherit
-- ordering, keyset pagination, the read watermark and last_message_at for free,
-- and they appear in the conversation list preview — which is what you want, an
-- audit trail woven into the thread rather than beside it.
--
-- `event` names what happened, so the client can render an icon or filter without
-- parsing English out of `body`. `body` still carries the finished sentence,
-- baked at write time with the names as they were then: resolving it at read time
-- would make a two-year-old "Alex added Jamie" line silently rewrite itself when
-- Jamie's display name changes, or turn into "Former member added Former member"
-- once either login is deleted.
ALTER TABLE chat_messages
  ADD COLUMN system_event text;

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_system_event_shape CHECK (
    (kind = 'system' AND system_event IS NOT NULL) OR
    (kind <> 'system' AND system_event IS NULL)
  );

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_system_event_valid CHECK (
    system_event IS NULL OR system_event IN (
      'group.created',
      'group.renamed',
      'group.avatar',
      'member.added',
      'member.removed',
      'member.left',
      'member.role'
    )
  );
