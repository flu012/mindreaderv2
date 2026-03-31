/**
 * Neo4j connection manager for MindReader
 */
import neo4j from "neo4j-driver";
import { getTenantId } from "./lib/tenant.js";

let _driver = null;

export function getDriver(config) {
  if (!_driver) {
    _driver = neo4j.driver(
      config.neo4jUri || "bolt://localhost:7687",
      neo4j.auth.basic(
        config.neo4jUser || "neo4j",
        config.neo4jPassword || ""
      ),
      {
        // Detect and discard defunct connections before they cause errors
        maxConnectionLifetime: 30 * 60 * 1000, // 30 min — recycle idle connections
        connectionAcquisitionTimeout: 30 * 1000, // 30s — fail fast if pool exhausted
        maxConnectionPoolSize: 50,
      }
    );
  }
  return _driver;
}

export async function closeDriver() {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}

/**
 * Run a Cypher query and return records as plain objects.
 */
export async function query(driver, cypher, params = {}) {
  const session = driver.session();
  try {
    const augmented = { ...params, __tenantId: getTenantId() };
    const result = await session.run(cypher, augmented);
    return recordsToPlain(result.records);
  } finally {
    await session.close();
  }
}

/**
 * Run a read-only Cypher query. Uses executeRead to enforce read-only at the driver level.
 */
export async function readQuery(driver, cypher, params = {}) {
  const session = driver.session();
  try {
    const augmented = { ...params, __tenantId: getTenantId() };
    const result = await session.executeRead((tx) => tx.run(cypher, augmented));
    return recordsToPlain(result.records);
  } finally {
    await session.close();
  }
}

function recordsToPlain(records) {
  return records.map((r) => {
    const obj = {};
    r.keys.forEach((key) => {
      obj[key] = convertValue(r.get(key));
    });
    return obj;
  });
}

/**
 * Recursively convert Neo4j types to plain JS values.
 */
function convertValue(val) {
  if (val === null || val === undefined) return val;
  if (neo4j.isInt(val)) return val.toNumber();
  if (neo4j.isDateTime(val) || neo4j.isDate(val) || neo4j.isTime(val) || neo4j.isLocalDateTime(val) || neo4j.isLocalTime(val)) {
    return val.toString();
  }
  // Neo4j Node — don't auto-convert, leave for nodeToPlain
  if (val.labels && val.properties) return val;
  // Neo4j Relationship — leave for relToPlain
  if (val.type && val.properties && val.start !== undefined) return val;
  // Plain object with nested DateTime fields (e.g. from RETURN r.created_at)
  if (typeof val === "object" && val.year !== undefined && val.month !== undefined && val.day !== undefined) {
    // Looks like a DateTime object not caught by neo4j.isDateTime
    try {
      const y = neo4j.isInt(val.year) ? val.year.toNumber() : val.year;
      const m = neo4j.isInt(val.month) ? val.month.toNumber() : val.month;
      const d = neo4j.isInt(val.day) ? val.day.toNumber() : val.day;
      const h = neo4j.isInt(val.hour) ? val.hour.toNumber() : (val.hour || 0);
      const mi = neo4j.isInt(val.minute) ? val.minute.toNumber() : (val.minute || 0);
      const s = neo4j.isInt(val.second) ? val.second.toNumber() : (val.second || 0);
      return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(s).padStart(2,'0')}Z`;
    } catch {
      return String(val);
    }
  }
  return val;
}

/**
 * Convert Neo4j node properties to plain object (handle integers, dates).
 */
function neo4jDateTimeToISO(dt) {
  // Convert Neo4j DateTime to standard ISO 8601 string (no [UTC] suffix)
  const s = dt.toString();
  return s.replace(/\[.*\]$/, ""); // Strip timezone annotation like [UTC]
}

export function nodeToPlain(node) {
  const obj = { _id: neo4j.isInt(node.identity) ? node.identity.toNumber() : node.identity };
  obj._labels = node.labels;
  for (const [key, val] of Object.entries(node.properties)) {
    if (neo4j.isInt(val)) {
      obj[key] = val.toNumber();
    } else if (val && typeof val === "object" && val.constructor?.name === "DateTime") {
      obj[key] = neo4jDateTimeToISO(val);
    } else {
      obj[key] = val;
    }
  }
  return obj;
}

export function relToPlain(rel) {
  const obj = { _type: rel.type };
  for (const [key, val] of Object.entries(rel.properties)) {
    if (neo4j.isInt(val)) {
      obj[key] = val.toNumber();
    } else if (val && typeof val === "object" && val.constructor?.name === "DateTime") {
      obj[key] = neo4jDateTimeToISO(val);
    } else if (key.endsWith("_embedding")) {
      // Skip large embedding arrays for API responses
      continue;
    } else {
      obj[key] = val;
    }
  }
  return obj;
}
