-- 0008_chat_mentions — who was @mentioned in which message.
--
-- ── The body already carries the ids, so why a table ──
--
-- A mention is stored inline as `@[Display Name](uuid)` (see lib/chat/mentions.ts),
-- which is what makes the *rendering* survive a rename. This table is not a second
-- copy of that for its own sake; it answers a different question:
--
--     "which messages mention me?"
--
-- Answering that from the body means scanning every row with a LIKE against a
-- uuid, which no index helps with. A notification badge, a future "mentions" tab,
-- and the per-recipient decision about whether a toast says "mentioned you" all
-- ask exactly that question, per person, on the hot path.
--
-- The two are written in the same transaction as the message, so they cannot
-- disagree — and if they ever did, the BODY is authoritative for what is
-- displayed, because that is what the sender wrote.
CREATE TABLE chat_message_mentions (
  message_id bigint      NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  -- CASCADE like reactions, not SET NULL like sender_id: a mention row with no
  -- user is a row that can never match the question this table exists to answer.
  -- The body keeps the name, so the message still reads correctly.
  user_id    uuid        NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Mentioning somebody twice in one message is one mention of them. The key is
  -- the de-duplication, so the writer does not have to be careful.
  PRIMARY KEY (message_id, user_id)
);

-- "Which messages mention me", newest first. The whole reason for the table.
CREATE INDEX chat_message_mentions_user_idx
  ON chat_message_mentions (user_id, message_id DESC);
