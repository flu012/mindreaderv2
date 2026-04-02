/**
 * Tenant Context — AsyncLocalStorage-based tenant isolation.
 *
 * Open-source mode: tenantId defaults to "master"
 * Cloud mode: tenantId comes from X-Tenant-Id header (set by .NET API proxy)
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const tenantStore = new AsyncLocalStorage();
export const DEFAULT_TENANT = "master";

export function getTenantId() {
  const ctx = tenantStore.getStore();
  return ctx?.tenantId || DEFAULT_TENANT;
}

export function tenantMiddleware(config) {
  const internalSecret = config?.internalSecret || process.env.INTERNAL_SECRET || "";

  return (req, res, next) => {
    // If auth middleware already set tenantId, use it
    const tenantId = req.tenantId || req.headers["x-tenant-id"] || DEFAULT_TENANT;

    // Validate internal secret for non-master tenant IDs from headers
    if (internalSecret && req.headers["x-tenant-id"] && req.headers["x-tenant-id"] !== DEFAULT_TENANT) {
      if (req.headers["x-internal-secret"] !== internalSecret) {
        return res.status(403).json({ error: "Invalid internal secret" });
      }
    }

    tenantStore.run({ tenantId }, () => {
      req.tenantId = tenantId;
      next();
    });
  };
}
