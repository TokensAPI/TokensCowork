-- What the console adds to a session: a free-text note and a few tags. The uploaded log itself
-- is never edited; an upload never touches these columns, so they survive later batches.
ALTER TABLE session_log_sessions ADD COLUMN note TEXT;
ALTER TABLE session_log_sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE session_log_sessions ADD COLUMN annotated_at INTEGER;
