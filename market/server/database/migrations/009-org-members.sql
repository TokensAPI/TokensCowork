-- A plugin the platform grants to an organization reaches every member by default. The
-- organization administrator may narrow it to named members: no row for (organization, plugin)
-- means every member, any row means only the listed users. The name is kept for the console.
CREATE TABLE market_org_members (
  organization_id INTEGER NOT NULL REFERENCES market_organizations(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES market_plugins(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL CHECK(user_id > 0),
  name TEXT NOT NULL,
  PRIMARY KEY(organization_id, plugin_id, user_id)
);
