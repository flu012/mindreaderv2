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
    if (internalSecret && req.headers["x-internal-secret"] !== internalSecret) {
      if (req.headers["x-tenant-id"] && req.headers["x-tenant-id"] !== DEFAULT_TENANT) {
        return res.status(403).json({ error: "Invalid internal secret" });
      }
    }

    const tenantId = req.headers["x-tenant-id"] || DEFAULT_TENANT;
    tenantStore.run({ tenantId }, () => {
      req.tenantId = tenantId;
      next();
    });
  };
}
