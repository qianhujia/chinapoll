-- Migration: Rename categories to topics and category_id to topic_id
-- Applied to production database

-- 1. Create new topics table with same structure
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9-]*' AND length(slug) BETWEEN 2 AND 40),
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 2. Copy data from categories to topics
INSERT INTO topics (id, slug, name, description, position, enabled, created_at)
SELECT id, slug, name, description, position, enabled, created_at FROM categories;

-- 3. Add topic_id column to polls
ALTER TABLE polls ADD COLUMN topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL;

-- 4. Copy category_id to topic_id
UPDATE polls SET topic_id = category_id;

-- 5. Create index for topic_id
CREATE INDEX IF NOT EXISTS idx_polls_topic_status
  ON polls(topic_id, status, created_at DESC);

-- 6. Drop old category index
DROP INDEX IF EXISTS idx_polls_category_status;

-- 7. Drop old category_id column (SQLite doesn't support DROP COLUMN directly,
--    so we leave it for now - it's harmless)
-- ALTER TABLE polls DROP COLUMN category_id;

-- 8. Drop old categories table (after verifying data migrated)
-- DROP TABLE categories;