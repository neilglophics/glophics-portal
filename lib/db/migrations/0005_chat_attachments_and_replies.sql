-- 0005_chat_attachments_and_replies — files on messages, and the reply relation.
--
-- Replies need NO schema change. `chat_messages.reply_to_id` has existed since
-- 0001 and `sendMessage` has always accepted it; what was missing was a way to
-- set it from the UI and a way to read the parent back cheaply. Both are code.
-- The only thing worth restating here is why the FK is what it is:
--
--   reply_to_id bigint REFERENCES chat_messages(id) ON DELETE SET NULL
--
-- SET NULL, not CASCADE. A reply is a message in its own right; hard-deleting the
-- thing it answered must not delete the answer. A soft-deleted parent keeps the
-- reference and the preview renders "Message deleted", which is the honest
-- rendering — somebody replied to something that is now gone.

-- ============================================================
-- Attachments
-- ============================================================

-- `chat_attachments` was created in 0001 and never written to. Three changes make
-- it usable, and the first is the one that matters.
--
-- ── An attachment exists BEFORE its message does ──
--
-- The composer shows a file, with its size and a remove button, before anything
-- is sent — and the upload has to happen then, so the user sees progress and an
-- error while they can still act on it. So there is a real interval in which an
-- attachment is stored, owned by somebody, and attached to nothing.
--
-- `message_id` therefore becomes NULLABLE, and null means exactly one thing:
-- staged, not yet sent. That is deliberately modelled in THIS table rather than a
-- separate `chat_pending_attachments`, because a staging table would duplicate
-- every column, need its own authorization rules, and give the orphan sweep two
-- places to look. One table, one lifecycle, and the sweep is a WHERE clause.
ALTER TABLE chat_attachments
  ALTER COLUMN message_id DROP NOT NULL;

-- Which conversation it was staged for, so a staged row can be authorized before
-- a message exists to authorize it through.
--
-- NOT NULL without a default is safe only because this table is empty — nothing
-- has ever written to it (see CLAUDE.md). If that is ever untrue this migration
-- fails loudly here, which is the right outcome: a row with no conversation could
-- not be authorized at all.
ALTER TABLE chat_attachments
  ADD COLUMN conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE;

-- Who staged it. THE authorization check on a staged row: only the uploader may
-- attach it to a message, so one member cannot send another member's pending file
-- by guessing its id.
--
-- SET NULL rather than CASCADE, matching chat_messages.sender_id: removing a login
-- must not delete files already sent into a conversation.
ALTER TABLE chat_attachments
  ADD COLUMN uploaded_by uuid REFERENCES auth_users(id) ON DELETE SET NULL;

-- A hard cap, well above what the upload route accepts (see lib/chat/attachments.ts).
-- This is the backstop for a route that stopped checking, not the limit itself.
ALTER TABLE chat_attachments
  ADD CONSTRAINT chat_attachments_bytes_bounded CHECK (bytes <= 26214400);

-- The mime type is NOT constrained to a list here, for the same reason the
-- reaction emoji are not (0004): the allowlist is read by the file picker AND
-- enforced by the upload route, and encoding it in SQL as well would mean a
-- migration to accept .xlsx. A length bound is the backstop.
ALTER TABLE chat_attachments
  ADD CONSTRAINT chat_attachments_mime_sane CHECK (length(mime) BETWEEN 1 AND 255);

-- Filenames are user input and end up in a Content-Disposition header.
ALTER TABLE chat_attachments
  ADD CONSTRAINT chat_attachments_filename_sane CHECK (length(filename) BETWEEN 1 AND 255);

-- The orphan sweep: files staged and never sent, because somebody picked a file
-- and then closed the tab. Without this the blob store accumulates paid-for bytes
-- that nothing in the database can find.
--
-- Partial, so it indexes only the handful of rows that are actually pending rather
-- than every attachment ever sent.
CREATE INDEX chat_attachments_pending_idx
  ON chat_attachments (created_at) WHERE message_id IS NULL;

-- "The attachments on this conversation", for the sweep and for per-conversation
-- accounting. chat_attachments_message_idx (0001) already covers the read path.
CREATE INDEX chat_attachments_conversation_idx
  ON chat_attachments (conversation_id);

-- ============================================================
-- Where the bytes live, and why the URL is not a secret
-- ============================================================
--
-- Bytes go to Vercel Blob; only metadata is in Postgres. That is the split the
-- 0001 design already chose (`blob_url`, `blob_pathname`) and it is the right one
-- for attachments specifically: unlike an avatar, which is a couple of KB after
-- optimisation and lives in Postgres as bytea (0003), a PDF is megabytes and has
-- no business in a row.
--
-- ── Q6 is answered, and the answer came from the store's configuration ──
--
-- docs/06-OPEN-QUESTIONS.md Q6 asked whether a Blob URL is a capability anyone
-- can hold forever. For THIS store the question does not arise: it is configured
-- with **private** access, so `put` refuses `access: 'public'` outright and an
-- unauthenticated GET of a blob URL answers 403. There is no capability URL to
-- leak.
--
-- Reads therefore go through `/api/chat/attachments/[id]`, which checks
-- conversation membership and then streams the blob server-side. That is Q6's
-- recommended option B, and it is not optional here — it is the only way to read
-- a private blob at all. `blob_url` is kept because it is what the SDK's delete
-- takes unambiguously, and it is NEVER serialised to a client.
