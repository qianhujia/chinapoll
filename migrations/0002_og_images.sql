-- Open Graph cards: one rendered PNG per poll, kept beside the poll it describes.
--
-- The poll page points a card builder at /og/poll/<number>.png. Rendering happens in the
-- Worker (svg -> png, see worker/services/ogImage.ts) and the bytes are stored here as a
-- BLOB, never as hex text, so a repeated fetch answers from a single row read instead of
-- a second render. `signature` records what the picture was drawn from (the poll's title,
-- number, status, and counts); a row whose signature no longer matches the poll is drawn
-- again, which is how the hourly run keeps tallies current without redrawing every card.
-- `site_url` is the address the picture prints, kept so the hourly run can redraw a card
-- without a request telling it which origin the site is served from.
CREATE TABLE IF NOT EXISTS og_images (
  poll_id INTEGER PRIMARY KEY REFERENCES polls(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  content_type TEXT NOT NULL,
  image BLOB NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  site_url TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);

