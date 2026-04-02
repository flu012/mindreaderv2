/**
 * Authentication module for MindReader Express.
 *
 * Supports 3 auth methods (checked in order):
 * 1. httpOnly cookie JWT (browser UI)
 * 2. Bearer apiToken (OpenClaw, MCP, CLI)
 * 3. X-Internal-Secret (cloud proxy)
 * 4. No auth when AUTH_SECRET is empty (backwards compatible)
 *
 * Login endpoint validates email/password against .env values.
 * JWT contains tenantId claim for multi-tenant support.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Generate a JWT manually (no external dependency).
 * Simple HS256 implementation for self-contained auth.
 */
function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function signJwt(payload, secret, expiresInMs = 86400000) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + Math.floor(expiresInMs / 1000) };

  const segments = [base64url(JSON.stringify(header)), base64url(JSON.stringify(body))];
  const sigInput = segments.join(".");
  const sig = createHmac("sha256", secret).update(sigInput).digest("base64url");
  return `${sigInput}.${sig}`;
}

export function verifyJwt(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const sigInput = `${parts[0]}.${parts[1]}`;
    const expectedSig = createHmac("sha256", secret).update(sigInput).digest("base64url");
    // Timing-safe comparison to prevent signature guessing
    const sigBuf = Buffer.from(parts[2]);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Rate limiter for login endpoint.
 * Max 5 attempts per IP per minute.
 */
const loginAttempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60000;

export function checkRateLimit(ip) {
  const now = Date.now();
  // Periodic cleanup — remove expired entries to prevent memory leak
  if (loginAttempts.size > 1000) {
    for (const [k, v] of loginAttempts) {
      if (now > v.resetAt) loginAttempts.delete(k);
    }
  }
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

/**
 * Auth middleware — checks 3 auth methods in order.
 * Attaches req.tenantId and req.userEmail if authenticated.
 */
export function createAuthMiddleware(config) {
  const authSecret = config.authSecret || "";
  const apiToken = config.apiToken || "";
  const internalSecret = config.internalSecret || "";
  const authEnabled = !!authSecret;

  return (req, res, next) => {
    // Skip auth for auth endpoints (login, logout, status)
    // req.path is relative to mount point ("/api"), so /api/auth/login → /auth/login
    if (req.path.startsWith("/auth/")) return next();

    // Method 1: httpOnly cookie JWT
    const cookieToken = req.cookies?.mindreader_auth;
    if (cookieToken && authSecret) {
      const payload = verifyJwt(cookieToken, authSecret);
      if (payload) {
        req.userEmail = payload.email;
        req.tenantId = payload.tenantId || "master";
        return next();
      }
    }

    // Method 2: Bearer apiToken
    const authHeader = req.headers.authorization;
    if (authHeader && apiToken) {
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const tokenBuf = Buffer.from(token);
      const expectedBuf = Buffer.from(apiToken);
      if (tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf)) {
        req.tenantId = req.headers["x-tenant-id"] || "master";
        return next();
      }
    }

    // Method 3: X-Internal-Secret (cloud proxy)
    if (internalSecret && req.headers["x-internal-secret"] === internalSecret) {
      req.tenantId = req.headers["x-tenant-id"] || "master";
      return next();
    }

    // Method 4: Auth disabled (backwards compatible)
    if (!authEnabled) {
      req.tenantId = req.headers["x-tenant-id"] || "master";
      return next();
    }

    // All methods failed
    res.status(401).json({ error: "Authentication required" });
  };
}

/**
 * Generate random hex string for secrets/tokens.
 */
export function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}
