-- Local annotations are independent of the TokensAPI organization directory.
CREATE TABLE IF NOT EXISTS market_access_subjects (
 kind TEXT NOT NULL CHECK(kind IN ('key','organization')),
 id TEXT NOT NULL,
 label TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '',
 tags TEXT NOT NULL DEFAULT '[]',
 encrypted_value TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(kind,id)
);
CREATE TRIGGER IF NOT EXISTS market_access_subject_revision BEFORE UPDATE ON market_access_subjects
 WHEN NEW.revision != OLD.revision + 1
 BEGIN SELECT RAISE(ABORT,'subject revision conflict'); END;
