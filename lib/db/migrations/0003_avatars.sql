-- 0003_avatars — uploaded profile pictures.
--
-- A SEPARATE TABLE, not a column on auth_users, and that is the important part:
-- auth_users is read on every single authenticated request by resolveSession().
-- A bytea column there would sit one careless `SELECT *` away from pulling image
-- bytes into every session lookup in the app. Keeping it out of reach is cheaper
-- than trusting every future query to remember.
--
-- Bytes in Postgres rather than in Vercel Blob, deliberately. An optimised
-- 256x256 avatar is a couple of kilobytes, so the whole team's worth is smaller
-- than one page of the board — it needs no second service, no extra token, and
-- it avoids Blob's capability-URL question (docs/06-OPEN-QUESTIONS.md Q6)
-- entirely, because these bytes are served by a route handler that can check who
-- is asking.

CREATE TABLE auth_user_avatars (
  user_id    uuid        PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  bytes      bytea       NOT NULL,
  mime       text        NOT NULL,
  width      integer     NOT NULL,
  height     integer     NOT NULL,
  byte_size  integer     NOT NULL,
  -- Used as the cache-busting token in the image URL, so a new upload is picked
  -- up immediately despite the long client cache.
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- The upload route re-encodes everything through the optimiser, so anything
  -- outside this list means the pipeline changed and the constraint should be
  -- revisited rather than silently widened.
  CONSTRAINT auth_user_avatars_mime_valid
    CHECK (mime IN ('image/webp', 'image/avif', 'image/jpeg', 'image/png')),

  -- A stored avatar is always the OPTIMISED output, which for 256x256 is a few
  -- KB. The 1 MB the upload route accepts is the limit on what a user may SEND,
  -- not on what gets kept; this backstop catches a pipeline that stopped
  -- optimising rather than trusting the route to have.
  CONSTRAINT auth_user_avatars_size_sane
    CHECK (byte_size > 0 AND byte_size <= 512 * 1024),

  CONSTRAINT auth_user_avatars_dimensions_sane
    CHECK (width BETWEEN 1 AND 1024 AND height BETWEEN 1 AND 1024)
);
