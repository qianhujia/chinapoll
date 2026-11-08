-- The poll card is now just the site's name over the poll's title (see
-- worker/services/ogCard.ts), so it no longer prints the poll's address. The column that
-- held that address is dropped; nothing reads it anymore. An older stored card is redrawn on
-- its next fetch, because the freshness signature no longer carries the counts either.
ALTER TABLE og_images DROP COLUMN site_url;
