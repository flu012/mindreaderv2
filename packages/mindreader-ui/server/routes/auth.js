/**
 * Auth routes — POST /api/auth/login, POST /api/auth/logout
 */
import { signJwt, checkRateLimit } from "../lib/auth.js";

export function registerRoutes(app, ctx) {
  const { config, logger } = ctx;

  /**
   * POST /api/auth/login — Authenticate and set httpOnly cookie
   */
  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body || {};

    // Rate limiting
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: "Too many login attempts. Try again in a minute." });
    }

    // Validate credentials against .env
    const adminEmail = config.authAdminEmail || "";
    const adminPassword = config.authAdminPassword || "";

    if (!adminEmail || !adminPassword) {
      return res.status(503).json({ error: "Authentication not configured. Run setup wizard." });
    }

    if (email !== adminEmail || password !== adminPassword) {
      logger?.warn?.(`Failed login attempt for ${email} from ${ip}`);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Generate JWT
    const token = signJwt(
      { email, tenantId: "master" },
      config.authSecret,
      86400000 // 24 hours
    );

    // Set httpOnly cookie
    res.cookie("mindreader_auth", token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/api",
      maxAge: 86400000, // 24 hours
      secure: req.secure || req.headers["x-forwarded-proto"] === "https",
    });

    logger?.info?.(`Login successful for ${email}`);
    res.json({
      ok: true,
      user: { email, tenantId: "master" },
      // Also return token for programmatic clients that can't use cookies
      token,
    });
  });

  /**
   * POST /api/auth/logout — Clear auth cookie
   */
  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("mindreader_auth", { path: "/api" });
    res.json({ ok: true });
  });

  /**
   * GET /api/auth/status — Check if authenticated
   */
  app.get("/api/auth/status", (req, res) => {
    const authEnabled = !!config.authSecret;
    res.json({
      authenticated: !!req.userEmail || !authEnabled,
      authEnabled,
      email: req.userEmail || null,
      tenantId: req.tenantId || "master",
    });
  });
}
