/**
 * Category routes — /api/categories/* + /api/recategorize
 */
import path from "node:path";
import { tmpdir } from "node:os";
import neo4j from "neo4j-driver";
import { query } from "../neo4j.js";
import { getCategories, categorizeEntity } from "../lib/categorizer.js";
import { venvPython } from "../config.js";

export function registerRoutes(app, ctx) {
  const { driver, config, logger } = ctx;

  /**
   * GET /api/categories — List all categories with entity counts
   */
  app.get("/api/categories", async (req, res) => {
    try {
      const freshCats = await getCategories(driver, /* forceRefresh */ true);

      // Get all entity categories to count
      const entityRows = await query(driver,
        `MATCH (e:Entity) RETURN COALESCE(e.category, e.group_id, '') AS category`
      );
      const catKeys = new Set(freshCats.map((c) => c.key));

      const counts = {};
      let otherCount = 0;
      for (const row of entityRows) {
        const cat = row.category;
        if (cat && catKeys.has(cat)) {
          counts[cat] = (counts[cat] || 0) + 1;
        } else {
          // null category or not in any Category node -> "other"
          otherCount++;
        }
      }
      // Also auto-categorize entities with no manual category
      const uncat = await query(driver,
        `MATCH (e:Entity) WHERE (e.group_id IS NULL AND e.category IS NULL) OR NOT COALESCE(e.category, e.group_id, '') IN $keys RETURN e.name AS name, e.summary AS summary, COALESCE(e.category, e.group_id, '') AS category`,
        { keys: [...catKeys] }
      );
      const autoCounts = {};
      for (const row of uncat) {
        const auto = categorizeEntity(row.name, row.summary, null);
        autoCounts[auto] = (autoCounts[auto] || 0) + 1;
      }

      const result = freshCats.map((c) => ({
        key: c.key,
        label: c.label,
        color: c.color,
        keywords: c.keywords || "",
        order: c.order || 99,
        count: (counts[c.key] || 0) + (autoCounts[c.key] || 0),
      }));

      res.json(result);
    } catch (err) {
      logger?.error?.(`Categories API error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/categories — Create new category
   */
  app.post("/api/categories", async (req, res) => {
    try {
      const { key, label, color, keywords, order } = req.body;
      if (!key) return res.status(400).json({ error: "key is required" });
      if (key === "other") return res.status(400).json({ error: "Cannot create a category with key 'other'" });

      // Check uniqueness
      const existing = await query(driver, `MATCH (c:Category {key: $key}) RETURN c`, { key });
      if (existing.length > 0) return res.status(409).json({ error: `Category '${key}' already exists` });

      await query(driver,
        `CREATE (c:Category {key: $key, label: $label, color: $color, keywords: $keywords, order: $order})`,
        { key, label: label || key, color: color || "#8888aa", keywords: keywords || "", order: order || 50 }
      );

      res.json({ ok: true, key });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/categories/merge — Merge two categories
   */
  app.post("/api/categories/merge", async (req, res) => {
    try {
      const { sourceKey, targetKey } = req.body;
      if (!sourceKey || !targetKey) return res.status(400).json({ error: "sourceKey and targetKey required" });
      if (sourceKey === targetKey) return res.status(400).json({ error: "Source and target must be different" });
      if (sourceKey === "other") return res.status(400).json({ error: "Cannot merge 'other' as source" });

      // Move entities from source to target
      const moved = await query(driver,
        `MATCH (e:Entity) WHERE e.category = $sourceKey SET e.category = $targetKey RETURN count(e) AS count`,
        { sourceKey, targetKey }
      );
      const movedCount = moved[0]?.count?.toNumber?.() || moved[0]?.count || 0;

      // Merge keywords
      const sourceCat = await query(driver, `MATCH (c:Category {key: $key}) RETURN c`, { key: sourceKey });
      const targetCat = await query(driver, `MATCH (c:Category {key: $key}) RETURN c`, { key: targetKey });
      if (sourceCat.length && targetCat.length) {
        const srcKw = (sourceCat[0].c?.properties?.keywords || sourceCat[0].c?.keywords || "").split(",").map((k) => k.trim()).filter(Boolean);
        const tgtKw = (targetCat[0].c?.properties?.keywords || targetCat[0].c?.keywords || "").split(",").map((k) => k.trim()).filter(Boolean);
        const merged = [...new Set([...tgtKw, ...srcKw])].join(",");
        await query(driver, `MATCH (c:Category {key: $key}) SET c.keywords = $keywords`, { key: targetKey, keywords: merged });
      }

      // Delete source category
      await query(driver, `MATCH (c:Category {key: $key}) DELETE c`, { key: sourceKey });

      res.json({ ok: true, merged: sourceKey, into: targetKey, entitiesMoved: movedCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/categories/:key/entities — Get entities in a category
   */
  app.get("/api/categories/:key/entities", async (req, res) => {
    try {
      const { key } = req.params;
      const cats = await getCategories(driver);
      const catKeys = cats.map((c) => c.key);

      let entities;
      if (key === "other") {
        // Entities with no category or category not in any Category node
        const rows = await query(driver,
          `MATCH (e:Entity) WHERE (e.group_id IS NULL AND e.category IS NULL) OR NOT COALESCE(e.category, e.group_id, '') IN $keys
           RETURN e.uuid AS uuid, e.name AS name, e.summary AS summary, e.created_at AS created_at, e.node_type AS node_type, COALESCE(e.category, e.group_id, '') AS category
           ORDER BY e.name`,
          { keys: catKeys }
        );
        // Include entities that auto-categorize to "other"
        entities = rows
          .filter((r) => {
            const auto = categorizeEntity(r.name, r.summary, null);
            return !r.category || !catKeys.includes(r.category) || auto === "other";
          })
          .map((r) => ({
            uuid: r.uuid, name: r.name, summary: r.summary,
            created_at: r.created_at, node_type: r.node_type || "normal",
          }));
      } else {
        // Entities with explicit category = key OR auto-categorized to key
        const rows = await query(driver,
          `MATCH (e:Entity)
           RETURN e.uuid AS uuid, e.name AS name, e.summary AS summary, e.created_at AS created_at, e.node_type AS node_type, COALESCE(e.category, e.group_id, '') AS category
           ORDER BY e.name`
        );
        entities = rows
          .filter((r) => {
            const effective = categorizeEntity(r.name, r.summary, r.category);
            return effective === key;
          })
          .map((r) => ({
            uuid: r.uuid, name: r.name, summary: r.summary,
            created_at: r.created_at, node_type: r.node_type || "normal",
          }));
      }

      res.json(entities);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/categories/:key — Update category
   */
  app.put("/api/categories/:key", async (req, res) => {
    try {
      const { key } = req.params;
      const { label, color, keywords, order } = req.body;

      const sets = [];
      const params = { key };
      if (label !== undefined) { sets.push("c.label = $label"); params.label = label; }
      if (color !== undefined) { sets.push("c.color = $color"); params.color = color; }
      if (keywords !== undefined) { sets.push("c.keywords = $keywords"); params.keywords = keywords; }
      if (order !== undefined) { sets.push("c.order = $order"); params.order = order; }

      if (sets.length === 0) return res.status(400).json({ error: "Nothing to update" });

      await query(driver, `MATCH (c:Category {key: $key}) SET ${sets.join(", ")}`, params);

      res.json({ ok: true, key });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/categories/:key — Delete category (move entities to "other")
   */
  app.delete("/api/categories/:key", async (req, res) => {
    try {
      const { key } = req.params;
      if (key === "other") return res.status(400).json({ error: "Cannot delete 'other' category" });

      // Move all entities in this category to "other"
      const moved = await query(driver,
        `MATCH (e:Entity) WHERE e.category = $key SET e.category = 'other' RETURN count(e) AS count`,
        { key }
      );
      const movedCount = moved[0]?.count?.toNumber?.() || moved[0]?.count || 0;

      // Delete the Category node
      await query(driver, `MATCH (c:Category {key: $key}) DELETE c`, { key });

      res.json({ deleted: key, entitiesMoved: movedCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/recategorize — Re-categorize entities via LLM in batches
   * Body: { scope: "all" | "other" | "uncategorized", batchSize: 20 }
   */
  app.post("/api/recategorize", async (req, res) => {
    try {
      const { scope = "other", batchSize = 20, skip = 0 } = req.body || {};
      const maxBatch = Math.min(parseInt(batchSize) || 20, 50);
      const safeSkip = Math.max(parseInt(skip) || 0, 0);

      let cypher;
      if (scope === "all") {
        cypher = `MATCH (e:Entity) RETURN e.name AS name, e.summary AS summary, elementId(e) AS eid, e.category AS oldCat ORDER BY e.name SKIP $skip LIMIT $limit`;
      } else if (scope === "uncategorized") {
        cypher = `MATCH (e:Entity) WHERE e.category IS NULL OR e.category = '' RETURN e.name AS name, e.summary AS summary, elementId(e) AS eid, e.category AS oldCat LIMIT $limit`;
      } else {
        // Default: "other" — re-categorize entities currently tagged as "other"
        cypher = `MATCH (e:Entity) WHERE e.category = 'other' OR e.category IS NULL OR e.category = '' RETURN e.name AS name, e.summary AS summary, elementId(e) AS eid, e.category AS oldCat LIMIT $limit`;
      }

      const session = driver.session();
      try {
        const result = await session.run(cypher, { limit: neo4j.int(maxBatch), skip: neo4j.int(safeSkip) });
        const records = result.records;
        if (records.length === 0) {
          return res.json({ message: "No entities to recategorize", processed: 0, remaining: 0 });
        }

        // Build entity list for LLM
        const entities = records.map((rec, i) => ({
          idx: i,
          name: rec.get("name") || "",
          summary: (rec.get("summary") || "").slice(0, 200),
          eid: rec.get("eid"),
          oldCat: rec.get("oldCat"),
        }));

        const cats = await getCategories(driver);
        const validCats = cats.filter(c => c.key !== "other");
        const catList = validCats.map(c => `- ${c.key}: ${c.label}${c.keywords ? ` (e.g. ${c.keywords.split(",").slice(0, 3).join(", ")})` : ""}`).join("\n");
        const validKeys = validCats.map(c => c.key);

        const entityList = entities.map(e =>
          `${e.idx}. "${e.name}" — ${e.summary || "no summary"}`
        ).join("\n");

        const prompt = `Categorize each entity into ONE of these categories, or "other" if none fit.

Categories:
${catList}
- other: Does not fit any category (noise, implementation details, UI elements, code artifacts)

Entities:
${entityList}

Rules:
- Choose the MOST SPECIFIC category that fits
- "other" means the entity is noise and should not be in the knowledge graph
- Be precise: a "Modal dialog" is NOT a project, "TypeScript" is NOT a project
- Only use "project" for actual software projects/repos, not technologies or tools

Return ONLY a JSON array: [{"idx": 0, "category": "person"}, ...]`;

        const { execFile: ef } = await import("node:child_process");
        const { promisify: pm } = await import("node:util");
        const { writeFileSync: wfs, unlinkSync: uls } = await import("node:fs");
        const efa = pm(ef);

        const recatUid = Math.random().toString(36).slice(2, 8);
        const tmpPrompt = path.join(tmpdir(), `mg_recat_${Date.now()}_${recatUid}.json`);
        wfs(tmpPrompt, JSON.stringify(prompt));

        const pyScript = `
import os, json
with open(os.getenv("MG_PROMPT_FILE")) as f:
    prompt = json.load(f)
if os.getenv("LLM_PROVIDER", "").lower() == "anthropic":
    import anthropic
    client = anthropic.Anthropic(api_key=os.getenv("LLM_API_KEY"))
    resp = client.messages.create(model=os.getenv("MG_MODEL", "claude-sonnet-4-6"), system="You MUST respond with valid JSON only. No markdown code blocks.", messages=[{"role": "user", "content": prompt}], temperature=0.1, max_tokens=2000)
    text = resp.content[0].text.strip()
else:
    from openai import OpenAI
    client = OpenAI(api_key=os.getenv("LLM_API_KEY"), base_url=os.getenv("LLM_BASE_URL"))
    kwargs = dict(model=os.getenv("MG_MODEL", "gpt-4o-mini"), messages=[{"role": "user", "content": prompt}], temperature=0.1, max_tokens=2000, response_format={"type": "json_object"})
    if "dashscope" in (os.getenv("LLM_BASE_URL") or ""):
        kwargs["extra_body"] = {"enable_thinking": False}
    resp = client.chat.completions.create(**kwargs)
    text = resp.choices[0].message.content.strip()
fence = chr(96)*3
if text.startswith(fence + "json"): text = text[len(fence)+4:]
if text.startswith(fence): text = text[len(fence):]
if text.endswith(fence): text = text[:-len(fence)]
text = text.strip()
try:
    data = json.loads(text)
    if isinstance(data, list):
        print(json.dumps(data))
    elif isinstance(data, dict):
        items = data.get("entities", data.get("results", data.get("items", [])))
        print(json.dumps(items if isinstance(items, list) else []))
    else:
        print("[]")
except Exception:
    print("[]")
`;
        const tmpScript = path.join(tmpdir(), `mg_recat_${Date.now()}_${recatUid}.py`);
        wfs(tmpScript, pyScript);

        const pyExe = venvPython(config.pythonPath);
        const pyEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
        if (config.llmApiKey) pyEnv.LLM_API_KEY = config.llmApiKey;
        if (config.llmBaseUrl) pyEnv.LLM_BASE_URL = config.llmBaseUrl;
        if (config.llmProvider) pyEnv.LLM_PROVIDER = config.llmProvider;
        pyEnv.MG_PROMPT_FILE = tmpPrompt;
        pyEnv.MG_MODEL = config.llmExtractModel || config.llmModel;

        let assignments;
        try {
          const { stdout } = await efa(pyExe, [tmpScript], { timeout: 60000, env: pyEnv });
          assignments = JSON.parse(stdout.trim());
        } finally {
          try { uls(tmpScript); } catch {}
          try { uls(tmpPrompt); } catch {}
        }

        if (!Array.isArray(assignments)) {
          return res.status(500).json({ error: "LLM returned invalid format" });
        }

        const changes = [];
        for (const a of assignments) {
          const entity = entities[a.idx];
          if (!entity) continue;
          // Skip entities where LLM returned unrecognized category -- don't default to "other"
          if (!a.category || ![...validKeys, "other"].includes(a.category)) continue;
          const cat = a.category;
          if (cat !== entity.oldCat) {
            await session.run(
              `MATCH (e:Entity) WHERE elementId(e) = $eid SET e.category = $cat`,
              { eid: entity.eid, cat }
            );
            changes.push({ name: entity.name, from: entity.oldCat || "none", to: cat });
          }
        }

        // Count remaining
        let remaining;
        if (scope === "all") {
          // For "all" scope, remaining = total - (skip + batch processed)
          const remainResult = await session.run(`MATCH (e:Entity) RETURN count(e) AS cnt`);
          const total = remainResult.records[0]?.get("cnt")?.toNumber?.() || remainResult.records[0]?.get("cnt") || 0;
          remaining = Math.max(0, total - safeSkip - records.length);
        } else {
          // For other/uncategorized scopes, re-count matching entities (already reflects changes)
          const remainResult = await session.run(
            `MATCH (e:Entity) WHERE e.category = 'other' OR e.category IS NULL OR e.category = '' RETURN count(e) AS cnt`
          );
          remaining = remainResult.records[0]?.get("cnt")?.toNumber?.() || remainResult.records[0]?.get("cnt") || 0;
        }

        res.json({
          processed: records.length,
          changed: changes.length,
          changes,
          remaining,
        });
      } finally {
        await session.close();
      }
    } catch (err) {
      logger?.warn?.(`MindReader: recategorize failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });
}
