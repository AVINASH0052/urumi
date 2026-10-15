-- Remember which seed slugs were applied, so a seeded server an admin removed doesn't come back on restart.
CREATE TABLE seeded_servers (slug text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now());
INSERT INTO seeded_servers (slug) SELECT slug FROM servers;
