/**
 * Memory Decay Engine
 *
 * Periodically calculates strength decay for entities and relationships.
 * - Strength decays exponentially based on time since last access
 * - Items accessed recently are reinforced (strength boosted)
 * - Items below threshold are auto-expired (soft delete via expired_at)
 * - Entities cascade-expire when all their edges are expired
 *
 * Decay formula: strength = exp(-lambda * days_since_last_access)
 * Default lambda=0.03 gives ~23-day half-life for unaccessed memories.
 */

// Note: uses driver.session() directly for write transactions, not the query() helper.

import { tenantStore, DEFAULT_TENANT, getTenantId } from "./tenant.js";

// Helper: build match clause that supports both uuid and name lookup
function buildEntityMatchClause(val, paramName = "name", alias = "e") {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
  return isUuid ? `${alias}.uuid = $${paramName}` : `toLower(${alias}.name) = toLower($${paramName})`;
}

/**
 * Reinforce an entity and its edges on access (search/recall/view).
 * Resets last_accessed_at to now, boosts strength by delta (capped at 1.0).
 */
export async function reinforceEntity(driver, entityName, delta = 0.3) {
  if (!entityName) return;
  const match = buildEntityMatchClause(entityName);
  const session = driver.session();
  try {
    const tenantId = getTenantId();
    await session.run(
      `MATCH (e:Entity) WHERE ${match} AND e.tenantId = $tenantId AND e.expired_at IS NULL
       SET e.last_accessed_at = datetime(),
           e.strength = CASE WHEN coalesce(e.strength, 1.0) + $delta > 1.0
                             THEN 1.0
                             ELSE coalesce(e.strength, 1.0) + $delta END`,
      { name: entityName, delta, tenantId }
    );
    await session.run(
      `MATCH (e:Entity)-[r:RELATES_TO]-() WHERE ${match} AND e.tenantId = $tenantId AND r.expired_at IS NULL
       SET r.last_accessed_at = datetime(),
           r.strength = CASE WHEN coalesce(r.strength, 1.0) + $delta > 1.0
                             THEN 1.0
                             ELSE coalesce(r.strength, 1.0) + $delta END`,
      { name: entityName, delta, tenantId }
    );
  } finally {
    await session.close();
  }
}

/**
 * Batch-reinforce multiple entities at once (for search results).
 * Uses UNWIND to do it in two queries instead of 2*N.
 */
export async function reinforceEntities(driver, entityNames, delta = 0.3) {
  if (!entityNames || entityNames.length === 0) return;
  const session = driver.session();
  try {
    const tenantId = getTenantId();
    await session.run(
      `UNWIND $names AS name
       MATCH (e:Entity) WHERE toLower(e.name) = toLower(name) AND e.tenantId = $tenantId AND e.expired_at IS NULL
       SET e.last_accessed_at = datetime(),
           e.strength = CASE WHEN coalesce(e.strength, 1.0) + $delta > 1.0
                             THEN 1.0
                             ELSE coalesce(e.strength, 1.0) + $delta END`,
      { names: entityNames, delta, tenantId }
    );
    await session.run(
      `UNWIND $names AS name
       MATCH (e:Entity)-[r:RELATES_TO]-() WHERE toLower(e.name) = toLower(name) AND e.tenantId = $tenantId AND r.expired_at IS NULL
       SET r.last_accessed_at = datetime(),
           r.strength = CASE WHEN coalesce(r.strength, 1.0) + $delta > 1.0
                             THEN 1.0
                             ELSE coalesce(r.strength, 1.0) + $delta END`,
      { names: entityNames, delta, tenantId }
    );
  } finally {
    await session.close();
  }
}

/**
 * Create the decay background job.
 * Follows the auto-categorizer pattern: start()/stop() with interval.
 */
export function createDecayJob(driver, config, logger) {
  let _interval = null;
  let _initialTimeout = null;
  let _running = false;

  const lambda = config.memoryDecayLambda || 0.03;
  const threshold = config.memoryDecayThreshold || 0.1;
  const intervalMs = config.memoryDecayIntervalMs || 3600000;

  async function runDecayCycle() {
    if (_running) return false;
    _running = true;
    const session = driver.session();
    try {
      const tenantId = getTenantId();
      // Step 1: Calculate and update strength for all active edges
      const edgeResult = await session.run(
        `MATCH (e:Entity)-[r:RELATES_TO]->() WHERE e.tenantId = $tenantId AND r.expired_at IS NULL
         WITH r, duration.inSeconds(coalesce(r.last_accessed_at, r.created_at, datetime()), datetime()).seconds / 86400.0 AS daysSinceAccess
         WITH r, daysSinceAccess, exp(-1.0 * $lambda * daysSinceAccess) AS newStrength
         SET r.strength = newStrength
         RETURN count(r) AS updated`,
        { lambda, tenantId }
      );
      const edgesUpdated = edgeResult.records[0]?.get("updated")?.toNumber?.() || 0;

      // Step 2: Auto-expire edges below threshold
      const edgeExpireResult = await session.run(
        `MATCH (e:Entity)-[r:RELATES_TO]->() WHERE e.tenantId = $tenantId AND r.expired_at IS NULL AND r.strength < $threshold
         SET r.expired_at = datetime()
         RETURN count(r) AS expired`,
        { threshold, tenantId }
      );
      const edgesExpired = edgeExpireResult.records[0]?.get("expired")?.toNumber?.() || 0;

      // Step 3: Calculate and update strength for all active entities
      const entityResult = await session.run(
        `MATCH (e:Entity) WHERE e.tenantId = $tenantId AND e.expired_at IS NULL
         WITH e, duration.inSeconds(coalesce(e.last_accessed_at, e.created_at, datetime()), datetime()).seconds / 86400.0 AS daysSinceAccess
         WITH e, daysSinceAccess, exp(-1.0 * $lambda * daysSinceAccess) AS newStrength
         SET e.strength = newStrength
         RETURN count(e) AS updated`,
        { lambda, tenantId }
      );
      const entitiesUpdated = entityResult.records[0]?.get("updated")?.toNumber?.() || 0;

      // Step 4: Auto-expire entities below threshold
      const entityExpireResult = await session.run(
        `MATCH (e:Entity) WHERE e.tenantId = $tenantId AND e.expired_at IS NULL AND e.strength < $threshold
         SET e.expired_at = datetime()
         RETURN count(e) AS expired`,
        { threshold, tenantId }
      );
      const entitiesExpired = entityExpireResult.records[0]?.get("expired")?.toNumber?.() || 0;

      // Step 5: Cascade — expire entities where ALL edges are expired
      const cascadeResult = await session.run(
        `MATCH (e:Entity) WHERE e.tenantId = $tenantId AND e.expired_at IS NULL
         WITH e, [(e)-[r:RELATES_TO]-() | r] AS allRels
         WHERE size(allRels) > 0 AND ALL(r IN allRels WHERE r.expired_at IS NOT NULL)
         SET e.expired_at = datetime(), e.strength = 0.0
         RETURN count(e) AS cascaded`,
        { tenantId }
      );
      const cascaded = cascadeResult.records[0]?.get("cascaded")?.toNumber?.() || 0;

      if (edgesExpired > 0 || entitiesExpired > 0 || cascaded > 0) {
        logger?.info?.(`Decay: edges=${edgesUpdated} updated, ${edgesExpired} expired | entities=${entitiesUpdated} updated, ${entitiesExpired} expired | ${cascaded} cascade-expired`);
      }
      return true;
    } catch (err) {
      logger?.warn?.(`Decay cycle error: ${err.message}`);
      return false;
    } finally {
      await session.close();
      _running = false;
    }
  }

  return {
    start() {
      if (!config.memoryDecayEnabled) {
        logger?.info?.("Memory decay: disabled");
        return;
      }
      logger?.info?.(`Memory decay: enabled (interval=${intervalMs}ms, lambda=${lambda}, threshold=${threshold})`);
      _initialTimeout = setTimeout(() => {
        tenantStore.run({ tenantId: DEFAULT_TENANT }, runDecayCycle);
      }, 30000);
      _interval = setInterval(() => {
        tenantStore.run({ tenantId: DEFAULT_TENANT }, runDecayCycle);
      }, intervalMs);
    },
    stop() {
      if (_initialTimeout) clearTimeout(_initialTimeout);
      if (_interval) clearInterval(_interval);
      _initialTimeout = null;
      _interval = null;
    },
    runNow: runDecayCycle,
  };
}
