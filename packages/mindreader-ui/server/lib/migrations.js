/**
 * Schema Migration Runner
 *
 * Tracks applied migrations in Neo4j via :Migration nodes.
 * Each migration runs exactly once. New migrations are applied
 * automatically on server startup (called from init-indexes.js).
 *
 * To add a new migration:
 * 1. Add an entry to the MIGRATIONS array below
 * 2. Give it a unique `name` (use format: YYYYMMDD_description)
 * 3. Provide `up` as a Cypher string or async function(session, logger)
 * 4. The runner will apply it on next startup
 */

const MIGRATIONS = [
  {
    name: "20260328_add_decay_fields_to_entities",
    description: "Add strength, last_accessed_at, expired_at to Entity nodes",
    up: `MATCH (e:Entity) WHERE e.strength IS NULL
         SET e.strength = 1.0,
             e.last_accessed_at = coalesce(e.created_at, datetime()),
             e.expired_at = null
         RETURN count(e) AS affected`,
  },
  {
    name: "20260328_add_decay_fields_to_edges",
    description: "Add strength, last_accessed_at to RELATES_TO edges",
    up: `MATCH ()-[r:RELATES_TO]->() WHERE r.strength IS NULL
         SET r.strength = 1.0,
             r.last_accessed_at = coalesce(r.created_at, datetime())
         RETURN count(r) AS affected`,
  },
  {
    name: "20260328_add_details_field",
    description: "Add details field to Entity nodes, initialize from summary",
    up: `MATCH (e:Entity) WHERE e.details IS NULL
         SET e.details = coalesce(e.summary, "")
         RETURN count(e) AS affected`,
  },
  {
    name: "20260328_truncate_summary_to_200",
    description: "Truncate existing summaries to 200 chars (details now holds full content)",
    up: `MATCH (e:Entity) WHERE e.summary IS NOT NULL AND size(e.summary) > 200
         SET e.summary = left(e.summary, 200)
         RETURN count(e) AS affected`,
  },
];

/**
 * Run all pending migrations.
 * @param {object} driver - Neo4j driver
 * @param {object} [logger] - Optional logger
 * @returns {Promise<number>} Number of migrations applied
 */
export async function runMigrations(driver, logger) {
  const session = driver.session();
  try {
    // Ensure Migration constraint exists
    try {
      await session.run(
        `CREATE CONSTRAINT migration_name IF NOT EXISTS FOR (m:Migration) REQUIRE m.name IS UNIQUE`
      );
    } catch {
      // Older Neo4j versions may not support this syntax — ignore
    }

    // Get already-applied migrations
    const result = await session.run(`MATCH (m:Migration) RETURN m.name AS name`);
    const applied = new Set(result.records.map(r => r.get("name")));

    let count = 0;
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) continue;

      logger?.info?.(`Migration: running ${migration.name} — ${migration.description}`);
      try {
        let affected = 0;
        if (typeof migration.up === "string") {
          const res = await session.run(migration.up);
          affected = res.records[0]?.get("affected")?.toNumber?.() || 0;
        } else if (typeof migration.up === "function") {
          affected = await migration.up(session, logger);
        }

        // Record migration as applied
        await session.run(
          `CREATE (m:Migration {name: $name, description: $desc, applied_at: datetime(), affected: $affected})`,
          { name: migration.name, desc: migration.description, affected }
        );
        logger?.info?.(`Migration: ${migration.name} complete (${affected} records affected)`);
        count++;
      } catch (err) {
        logger?.warn?.(`Migration: ${migration.name} FAILED: ${err.message}`);
        // Don't record failed migrations — they'll retry next startup
      }
    }

    if (count === 0) {
      logger?.info?.(`Migrations: all up to date (${applied.size} applied)`);
    }
    return count;
  } finally {
    await session.close();
  }
}
