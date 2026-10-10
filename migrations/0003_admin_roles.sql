-- Role support for admin users.
-- role: 1 = admin, 2 = super admin. The first admin (created by first-run setup
-- or the CLI while no admin exists) is a super admin. Schema change only; the
-- column defaults to the regular admin role for any pre-existing rows.

ALTER TABLE admin_users ADD COLUMN role INTEGER NOT NULL DEFAULT 1;
