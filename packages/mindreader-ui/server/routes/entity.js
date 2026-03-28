/**
 * Entity routes — all /api/entity/:name routes + /api/merge + /api/link
 */
import path from "node:path";
import { tmpdir } from "node:os";
import neo4j from "neo4j-driver";
import { query, nodeToPlain, relToPlain } from "../neo4j.js";
import { categorizeEntity } from "../lib/categorizer.js";
import { reinforceEntity } from "../lib/decay.js";
import { EXTRACTION_INSTRUCTIONS } from "../lib/preprocessor.js";
import { venvPython } from "../config.js";

export function registerRoutes(app, ctx) {
  const { driver, config, logger, mgDaemon } = ctx;

  /**
   * GET /api/entity/:name — Entity detail with all relationships
   */
  app.get("/api/entity/:name", async (req, res) => {
    try {
      const { name } = req.params;

      // Get entity
      const entities = await query(driver,
        `MATCH (e:Entity)
         WHERE toLower(e.name) = toLower($name)
         RETURN e LIMIT 1`,
        { name }
      );

      if (!entities.length) {
        return res.status(404).json({ error: "Entity not found" });
      }

      const entity = entities[0].e ? nodeToPlain(entities[0].e) : entities[0];

      // Get relationships
      const rels = await query(driver,
        `MATCH (e:Entity)-[r:RELATES_TO]-(other:Entity)
         WHERE toLower(e.name) = toLower($name) AND r.expired_at IS NULL
         RETURN r, other,
                CASE WHEN startNode(r) = e THEN 'outgoing' ELSE 'incoming' END AS direction
         LIMIT 50`,
        { name }
      );

      const relationships = rels.map((rec) => {
        const rel = rec.r ? relToPlain(rec.r) : {};
        const otherNode = rec.other?.properties || rec.other || {};
        return {
          ...rel,
          direction: rec.direction,
          other: {
            name: otherNode.name || "unknown",
            uuid: otherNode.uuid || "",
            node_type: otherNode.node_type || "normal",
          },
        };
      });

      // Reinforce accessed entity (fire-and-forget)
      reinforceEntity(driver, name, config.memoryDecayReinforceDelta).catch(() => {});

      res.json({ entity, relationships });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/entity/:name — Update entity properties (tags, category, summary, node_type)
   */
  app.put("/api/entity/:name", async (req, res) => {
    try {
      const { name } = req.params;
      const { tags, category, summary, node_type, group_id } = req.body || {};

      const setClauses = [];
      const params = { name };

      if (tags !== undefined) {
        if (!Array.isArray(tags)) {
          return res.status(400).json({ error: "'tags' must be an array of strings" });
        }
        const normalized = [...new Set(tags.filter(t => typeof t === "string" && t.trim()).map(t => t.toLowerCase().trim()))].sort();
        setClauses.push("e.tags = $tags");
        params.tags = normalized;
      }
      if (category !== undefined) {
        setClauses.push("e.category = $category");
        params.category = category;
      }
      if (summary !== undefined) {
        setClauses.push("e.summary = $summary");
        params.summary = summary;
      }
      if (node_type !== undefined) {
        setClauses.push("e.node_type = $node_type");
        params.node_type = node_type;
      }
      if (group_id !== undefined) {
        setClauses.push("e.category = $category_legacy");
        params.category_legacy = group_id;
      }

      if (setClauses.length === 0) {
        return res.status(400).json({ error: "Nothing to update" });
      }

      const result = await query(driver,
        `MATCH (e:Entity) WHERE toLower(e.name) = toLower($name)
         SET ${setClauses.join(", ")}
         RETURN e`,
        params
      );

      if (!result.length) {
        return res.status(404).json({ error: "Entity not found" });
      }

      const entity = result[0].e ? nodeToPlain(result[0].e) : result[0];
      res.json({ entity });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/entity/:name/summarize — Summarize entity and all related nodes (all levels)
   * Uses LLM to generate a 200-word summary
   */
  app.get("/api/entity/:name/summarize", async (req, res) => {
    try {
      const { name } = req.params;

      // Single efficient query: get entity + direct relationships + connected entities
      const results = await query(driver,
        `MATCH (start:Entity)
         WHERE toLower(start.name) = toLower($name)
         OPTIONAL MATCH (start)-[r:RELATES_TO]-(other:Entity)
         WHERE r.expired_at IS NULL
         WITH start,
              collect(DISTINCT {name: other.name, summary: other.summary}) AS connected,
              collect(DISTINCT {relation: r.name, fact: r.fact, otherName: other.name}) AS relFacts
         RETURN start, connected[0..30] AS connected, relFacts[0..50] AS relFacts`,
        { name }
      );

      if (!results.length) {
        return res.status(404).json({ error: "Entity not found" });
      }

      const startNode = results[0].start?.properties || {};
      const connected = results[0].connected || [];
      const relFacts = results[0].relFacts || [];

      // Build context for LLM
      const entityInfo = [
        `Entity: ${startNode.name || name}`,
        startNode.summary ? `Summary: ${startNode.summary}` : null,
        `Connected to ${connected.length} other entities.`,
      ].filter(Boolean).join("\n");

      const relInfo = relFacts.map(r =>
        `- [${r.relation}] ${r.fact || `${startNode.name} → ${r.otherName}`}`
      ).join("\n");

      const connectedInfo = connected.slice(0, 30).map(n =>
        `- ${n.name}: ${(n.summary || "").slice(0, 100)}`
      ).join("\n");

      const llmPrompt = `Summarize this knowledge graph entity and all its relationships in exactly 200 words. Write in clear, concise language that helps someone quickly understand what this entity is, what it's connected to, and why it matters.

${entityInfo}

Relationships:
${relInfo || "None"}

Connected entities:
${connectedInfo || "None"}

Write a 200-word summary:`;

      // Call LLM via Python
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const execFileAsync = promisify(execFile);

      const sumUid = Math.random().toString(36).slice(2, 8);
      const tmpPrompt = path.join(tmpdir(), `mg_summarize_${Date.now()}_${sumUid}.json`);
      writeFileSync(tmpPrompt, JSON.stringify(llmPrompt));

      const extractModel = config.llmExtractModel || config.llmModel;
      const pyScript = `
import os, json
with open(os.getenv("MG_PROMPT_FILE")) as f:
    prompt = json.load(f)
if os.getenv("LLM_PROVIDER", "").lower() == "anthropic":
    import anthropic
    client = anthropic.Anthropic(api_key=os.getenv("LLM_API_KEY"))
    resp = client.messages.create(model=os.getenv("MG_MODEL", "claude-sonnet-4-6"), messages=[{"role": "user", "content": prompt}], temperature=0.3, max_tokens=400)
    print(resp.content[0].text.strip())
else:
    from openai import OpenAI
    client = OpenAI(api_key=os.getenv("LLM_API_KEY"), base_url=os.getenv("LLM_BASE_URL"))
    kwargs = dict(model=os.getenv("MG_MODEL", "gpt-4o-mini"), messages=[{"role": "user", "content": prompt}], temperature=0.3, max_tokens=400)
    if "dashscope" in (os.getenv("LLM_BASE_URL") or ""):
        kwargs["extra_body"] = {"enable_thinking": False}
    resp = client.chat.completions.create(**kwargs)
    print(resp.choices[0].message.content.strip())
`;

      const tmpScript = path.join(tmpdir(), `mg_summarize_${Date.now()}_${sumUid}.py`);
      writeFileSync(tmpScript, pyScript);

      const pyEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
      if (config.llmApiKey) pyEnv.LLM_API_KEY = config.llmApiKey;
      if (config.llmBaseUrl) pyEnv.LLM_BASE_URL = config.llmBaseUrl;
      if (config.llmProvider) pyEnv.LLM_PROVIDER = config.llmProvider;
      pyEnv.MG_PROMPT_FILE = tmpPrompt;
      pyEnv.MG_MODEL = extractModel;

      const pyExe = venvPython(config.pythonPath);
      const { stdout } = await execFileAsync(pyExe, [tmpScript], {
        timeout: 120000,
        env: pyEnv,
      });

      try { unlinkSync(tmpScript); } catch {}
      try { unlinkSync(tmpPrompt); } catch {}

      const generatedSummary = stdout.trim();

      // Save explanation to the Entity node in Neo4j (separate from summary)
      try {
        await query(driver,
          `MATCH (e:Entity)
           WHERE toLower(e.name) = toLower($name)
           SET e.explanation = $explanation, e.explanation_updated_at = datetime()`,
          { name, explanation: generatedSummary }
        );
      } catch (saveErr) {
        logger?.warn?.(`Failed to save explanation for ${name}: ${saveErr.message}`);
      }

      res.json({
        entity: startNode.name || name,
        connectedCount: connected.length,
        relationshipCount: relFacts.length,
        explanation: generatedSummary,
      });
    } catch (err) {
      logger?.error?.(`MindReader summarize error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ========================================================================
  // Node Evolve — SSE streaming endpoint
  // ========================================================================

  /**
   * POST /api/entity/:name/evolve — Evolve an entity via LLM with web search
   * Streams discovered entities/relationships as SSE events.
   * Request body: { focusQuestion?: string }
   */
  app.post("/api/entity/:name/evolve", async (req, res) => {
    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.flushHeaders();
    // Send initial SSE comment to keep connection alive
    res.write(": evolve stream starting\n\n");

    const sendSSE = (event, data) => {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    let aborted = false;
    let streamController = null;
    req.on("close", () => {
      if (!res.writableEnded) {
        // Only treat as abort if we didn't finish normally
        aborted = true;
        if (streamController) {
          try { streamController.abort(); } catch {}
        }
      }
    });

    try {
      const { name } = req.params;
      const { focusQuestion } = req.body || {};

      // Fetch entity + connections (same pattern as /summarize)
      const results = await query(driver,
        `MATCH (start:Entity)
         WHERE toLower(start.name) = toLower($name)
         OPTIONAL MATCH (start)-[r:RELATES_TO]-(other:Entity)
         WHERE r.expired_at IS NULL
         WITH start,
              collect(DISTINCT {name: other.name, summary: other.summary, category: COALESCE(other.category, other.group_id, '')}) AS connected,
              collect(DISTINCT {relation: r.name, fact: r.fact, otherName: other.name}) AS relFacts
         RETURN start, connected[0..30] AS connected, relFacts[0..50] AS relFacts`,
        { name }
      );

      if (!results.length) {
        sendSSE("error", { message: "Entity not found" });
        return res.end();
      }

      const startNode = results[0].start?.properties || {};
      const connected = results[0].connected || [];
      const relFacts = results[0].relFacts || [];

      // Build prompt
      const entityInfo = [
        `Name: ${startNode.name || name}`,
        `Category: ${startNode.category || startNode.group_id || "unknown"}`,
        startNode.summary ? `Summary: ${startNode.summary}` : null,
        startNode.tags?.length ? `Tags: ${startNode.tags.join(", ")}` : null,
      ].filter(Boolean).join("\n");

      const connectionsInfo = relFacts.map(r =>
        `- ${r.fact || `${startNode.name} [${r.relation}] ${r.otherName}`}`
      ).join("\n") || "None";

      const connectedEntities = connected.slice(0, 20).map(n =>
        `- ${n.name} (${n.category}): ${(n.summary || "").slice(0, 100)}`
      ).join("\n") || "None";

      const sanitizedFocus = (focusQuestion || "").slice(0, 500);
      const taskSection = sanitizedFocus
        ? `Research focus: ${sanitizedFocus}`
        : "Research this entity broadly. Discover important facts, related people, organizations, events, locations, and other entities.";

      const llmPrompt = `You are an internet research specialist. Your task is to **search the web** for real-world information about "${startNode.name || name}" and bring back NEW facts, context, and connections that are NOT already in the knowledge graph.

## Target Entity
${entityInfo}

## Already Known (DO NOT repeat these)
${connectionsInfo}

## Already Connected Entities (DO NOT rediscover these)
${connectedEntities}

## Research Task
${taskSection}

**You MUST perform web searches** to find current, factual information. Focus on:
1. Real-world facts — official websites, Wikipedia, news articles, public records
2. Recent developments — latest news, updates, changes, announcements
3. External context — industry, competitors, affiliations, achievements, history
4. Concrete details — dates, locations, numbers, titles, affiliations

Do NOT just reorganise or restate what is already known above. The value is in NEW information from external sources.

## Output Format

For each discovery, output [ENTITY] followed immediately by its [REL] on the next line(s):
[ENTITY] {"name": "Entity Name", "category": "person|organization|project|location|event|concept|tool|other", "summary": "One sentence description based on what you found online", "tags": ["tag1", "tag2"]}
[REL] {"source": "Source Entity", "target": "Target Entity", "label": "short_label", "fact": "A specific factual statement from your research"}

CRITICAL RULES:
- Every [ENTITY] MUST appear as source or target in at least one [REL]. No orphan entities.
- Every [REL] must connect back to "${startNode.name || name}", a Known Connection, or another discovered entity.
- Entity names must be proper nouns or specific names (people, organizations, projects, products, places, events).
- Do NOT create entities for roles, skills, descriptions, statuses, or attributes — put those in the "fact" field.
- Do NOT rediscover entities already listed in "Already Connected Entities" above.
- Relationship "fact" fields should contain specific, sourced information (e.g. "Founded in 2015 in San Francisco" not "Is a company").
- "source" is the entity performing the action, "target" is the entity being acted upon.

You may include reasoning text between [ENTITY]/[REL] lines. Aim for 10-25 new entities with real external information.`;

      // Call LLM with streaming via REST fetch
      const evolveModel = config.llmEvolveModel || config.llmModel;
      const baseUrl = (config.llmBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const isDashscope = baseUrl.includes("dashscope");
      const isAnthropic = config.llmProvider === "anthropic";

      let streamEndpoint, requestBody, requestHeaders;

      if (isAnthropic) {
        const anthropicBase = (config.llmBaseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
        streamEndpoint = `${anthropicBase}/messages`;
        requestBody = {
          model: evolveModel,
          messages: [{ role: "user", content: llmPrompt }],
          temperature: 0.5,
          max_tokens: 8000,
          stream: true,
        };
        requestHeaders = {
          "Content-Type": "application/json",
          "x-api-key": config.llmApiKey,
          "anthropic-version": "2023-06-01",
        };
      } else {
        streamEndpoint = `${baseUrl}/chat/completions`;
        requestBody = {
          model: evolveModel,
          messages: [{ role: "user", content: llmPrompt }],
          temperature: 0.5,
          max_tokens: 8000,
          stream: true,
        };
        if (isDashscope) {
          requestBody.enable_thinking = false;
          requestBody.enable_search = true;
        } else {
          requestBody.stream_options = { include_usage: true };
        }
        requestHeaders = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.llmApiKey}`,
        };
      }

      logger?.info?.(`[evolve] Starting for "${name}" model=${evolveModel} provider=${config.llmProvider}`);

      const abortCtrl = new AbortController();
      streamController = abortCtrl;

      // Use http/https module for reliable streaming (Node.js native fetch can buffer SSE)
      const streamUrl = new URL(streamEndpoint);
      const isHttps = streamUrl.protocol === "https:";
      const { request: httpRequest } = await import(isHttps ? "node:https" : "node:http");
      const postData = JSON.stringify(requestBody);

      // Streaming parser state
      let lineBuffer = "";
      let entityCount = 0;
      let relationshipCount = 0;
      let totalUsage = null;
      let sseBuffer = "";
      let rawChunkCount = 0;
      let dataLineCount = 0;

      // Extract text delta from an SSE chunk (handles both OpenAI and Anthropic formats)
      function extractTextAndUsage(chunk) {
        if (isAnthropic) {
          // Anthropic: usage in message_start and message_delta events
          if (chunk.type === "message_start" && chunk.message?.usage) {
            totalUsage = totalUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            totalUsage.promptTokens = chunk.message.usage.input_tokens || 0;
          }
          if (chunk.type === "message_delta" && chunk.usage) {
            totalUsage = totalUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            totalUsage.completionTokens = chunk.usage.output_tokens || 0;
            totalUsage.totalTokens = totalUsage.promptTokens + totalUsage.completionTokens;
          }
          // Content delta
          if (chunk.type === "content_block_delta" && chunk.delta?.text) {
            return chunk.delta.text;
          }
          return "";
        } else {
          // OpenAI-compatible format
          if (chunk.usage) {
            totalUsage = {
              promptTokens: chunk.usage.prompt_tokens || 0,
              completionTokens: chunk.usage.completion_tokens || 0,
              totalTokens: chunk.usage.total_tokens || 0,
            };
          }
          return chunk.choices?.[0]?.delta?.content || "";
        }
      }

      function processLineBuffer(text) {
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop();

        for (const ln of lines) {
          const trimmed = ln.trim();
          if (trimmed.startsWith("[ENTITY]")) {
            try {
              const entity = JSON.parse(trimmed.slice("[ENTITY]".length).trim());
              entityCount++;
              sendSSE("entity", entity);
            } catch {}
          } else if (trimmed.startsWith("[REL]")) {
            try {
              const rel = JSON.parse(trimmed.slice("[REL]".length).trim());
              relationshipCount++;
              sendSSE("relationship", rel);
            } catch {}
          }
        }
      }

      await new Promise((resolveStream, rejectStream) => {
        requestHeaders["Content-Length"] = Buffer.byteLength(postData);
        const httpReq = httpRequest({
          hostname: streamUrl.hostname,
          port: streamUrl.port || (isHttps ? 443 : 80),
          path: streamUrl.pathname,
          method: "POST",
          headers: requestHeaders,
        }, (llmResponse) => {
          logger?.info?.(`[evolve] LLM response status: ${llmResponse.statusCode}`);

          if (llmResponse.statusCode !== 200) {
            let errBody = "";
            llmResponse.on("data", (c) => { errBody += c; });
            llmResponse.on("end", () => rejectStream(new Error(`LLM API returned ${llmResponse.statusCode}: ${errBody.slice(0, 200)}`)));
            return;
          }

          llmResponse.on("data", (rawBuf) => {
          const rawText = rawBuf.toString();
          rawChunkCount++;

          sseBuffer += rawText;
          const sseMessages = sseBuffer.split("\n");
          sseBuffer = sseMessages.pop();

          for (const line of sseMessages) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine === "data: [DONE]") continue;
            // Anthropic uses "event: " lines — skip those
            if (trimmedLine.startsWith("event:")) continue;
            if (!trimmedLine.startsWith("data: ")) continue;
            dataLineCount++;

            let chunk;
            try { chunk = JSON.parse(trimmedLine.slice(6)); } catch { continue; }

            const text = extractTextAndUsage(chunk);
            if (!text) continue;

            sendSSE("token", { text });
            processLineBuffer(text);
          }
        });

        llmResponse.on("end", () => {
          // Flush remaining sseBuffer (last chunk may not end with \n)
          if (sseBuffer.trim()) {
            const trimmedSse = sseBuffer.trim();
            if (trimmedSse.startsWith("data: ") && trimmedSse !== "data: [DONE]") {
              try {
                const chunk = JSON.parse(trimmedSse.slice(6));
                const text = extractTextAndUsage(chunk);
                if (text) {
                  sendSSE("token", { text });
                  lineBuffer += text;
                }
              } catch {}
            }
            sseBuffer = "";
          }
          // Process remaining lineBuffer for [ENTITY]/[REL]
          if (lineBuffer.trim()) {
            const trimmed = lineBuffer.trim();
            if (trimmed.startsWith("[ENTITY]")) {
              try { const e = JSON.parse(trimmed.slice("[ENTITY]".length).trim()); entityCount++; sendSSE("entity", e); } catch {}
            } else if (trimmed.startsWith("[REL]")) {
              try { const r = JSON.parse(trimmed.slice("[REL]".length).trim()); relationshipCount++; sendSSE("relationship", r); } catch {}
            }
          }
          resolveStream();
        });

          llmResponse.on("error", rejectStream);
        });

        httpReq.on("error", rejectStream);
        abortCtrl.signal.addEventListener("abort", () => httpReq.destroy());
        httpReq.write(postData);
        httpReq.end();
      });

      logger?.info?.(`[evolve] Stream complete. entities: ${entityCount}, rels: ${relationshipCount}`);
      // Log token usage
      if (totalUsage) {
        try {
          await query(driver,
            `CREATE (t:TokenUsage {
               date: date(),
               model: $model,
               promptTokens: $promptTokens,
               completionTokens: $completionTokens,
               totalTokens: $totalTokens,
               operation: "evolve",
               timestamp: datetime()
             })`,
            {
              model: evolveModel,
              promptTokens: neo4j.int(totalUsage.promptTokens),
              completionTokens: neo4j.int(totalUsage.completionTokens),
              totalTokens: neo4j.int(totalUsage.totalTokens),
            }
          );
        } catch (tokenErr) {
          logger?.warn?.(`Failed to log evolve token usage: ${tokenErr.message}`);
        }
      }

      // Send done event
      sendSSE("done", {
        totalTokens: totalUsage?.totalTokens || 0,
        promptTokens: totalUsage?.promptTokens || 0,
        completionTokens: totalUsage?.completionTokens || 0,
        entityCount,
        relationshipCount,
      });

      res.end();
    } catch (err) {
      console.error(`[evolve] Error:`, err);
      if (!aborted) {
        logger?.error?.(`Node evolve error: ${err.message}`);
        const safeMsg = (err.message || "Unknown error").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/sk-[a-zA-Z0-9]+/g, "sk-[REDACTED]").slice(0, 200);
        try { sendSSE("error", { message: safeMsg }); } catch {}
      }
      res.end();
    }
  });

  /**
   * POST /api/entity/:name/evolve/save — Save evolved entities and relationships
   * Request body: { entities: [...], relationships: [...] }
   */
  /**
   * POST /api/entity/:name/evolve/save — Save evolved discoveries via the store pipeline.
   *
   * Instead of raw Cypher entity/relationship creation, we:
   * 1. Drop orphan entities (no relationships → never should have been discovered)
   * 2. Feed relationship facts to Graphiti in parallel batches with EXTRACTION_INSTRUCTIONS
   *    - Graphiti creates new entities with proper embeddings + deduplication
   * 3. EXTRACTION_INSTRUCTIONS prevent junk entities (roles, skills, attributes)
   */
  app.post("/api/entity/:name/evolve/save", async (req, res) => {
    try {
      const { name: targetName } = req.params;
      const { entities = [], relationships = [] } = req.body;

      if (!Array.isArray(entities) || !Array.isArray(relationships)) {
        return res.status(400).json({ error: "entities and relationships must be arrays" });
      }
      if (!relationships.length) {
        return res.status(400).json({ error: "No relationships to save" });
      }
      if (relationships.length > 200) {
        return res.status(400).json({ error: "Too many relationships (max 200)" });
      }

      // Validate relationship shapes
      for (const rel of relationships) {
        if (typeof rel.source !== "string" || !rel.source.trim() || rel.source.length > 200) {
          return res.status(400).json({ error: "Invalid relationship source" });
        }
        if (typeof rel.target !== "string" || !rel.target.trim() || rel.target.length > 200) {
          return res.status(400).json({ error: "Invalid relationship target" });
        }
        if (typeof rel.fact !== "string" || !rel.fact.trim() || rel.fact.length > 2000) {
          return res.status(400).json({ error: "Invalid or missing relationship fact" });
        }
      }

      // Drop orphan entities — only keep entities that appear in at least one relationship
      const entityNamesInRels = new Set();
      for (const rel of relationships) {
        entityNamesInRels.add(rel.source.trim().toLowerCase());
        entityNamesInRels.add(rel.target.trim().toLowerCase());
      }
      const connectedEntities = entities.filter(e =>
        entityNamesInRels.has(e.name.trim().toLowerCase())
      );
      const droppedOrphans = entities.length - connectedEntities.length;
      if (droppedOrphans > 0) {
        logger?.info?.(`[evolve/save] Dropped ${droppedOrphans} orphan entities with no relationships`);
      }

      // Feed relationship facts to Graphiti in parallel batches.
      // Evolve facts are already well-structured relationship sentences from the LLM,
      // so we skip the per-fact preprocessor (which would add an extra LLM call each)
      // and send them directly to Graphiti with EXTRACTION_INSTRUCTIONS.
      const BATCH_SIZE = 5;
      let storedCount = 0;
      const errors = [];

      for (let i = 0; i < relationships.length; i += BATCH_SIZE) {
        const batch = relationships.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(rel => {
            const fact = rel.fact.trim().slice(0, 2000);
            return mgDaemon("add", {
              content: fact,
              source: "evolve",
              project: targetName,
              custom_instructions: EXTRACTION_INSTRUCTIONS,
            }, 120000);
          })
        );
        for (const r of results) {
          if (r.status === "fulfilled") storedCount++;
          else errors.push(r.reason?.message || "unknown error");
        }
      }

      res.json({
        relationshipsProcessed: relationships.length,
        relationshipsStored: storedCount,
        orphansDropped: droppedOrphans,
        // Keep backwards-compatible fields for UI
        entitiesCreated: storedCount,
        entitiesSkipped: droppedOrphans,
        relationshipsCreated: storedCount,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err) {
      logger?.error?.(`Node evolve save error: ${err.message}`);
      res.status(500).json({ error: "Failed to save evolved data" });
    }
  });

  /**
   * POST /api/merge — Merge two entities (transfer all relationships, delete source)
   */
  app.post("/api/merge", async (req, res) => {
    try {
      const { keepName, mergeName, newSummary, newGroup } = req.body;
      if (!keepName || !mergeName) return res.status(400).json({ error: "Missing keepName or mergeName" });
      if (keepName === mergeName) return res.status(400).json({ error: "Cannot merge entity with itself" });

      // Transfer all RELATES_TO relationships from mergeName to keepName
      const transferred = await query(driver,
        `MATCH (src:Entity {name: $mergeName})-[r:RELATES_TO]-(other:Entity)
         WHERE other.name <> $keepName
         WITH src, r, other,
              CASE WHEN startNode(r) = src THEN 'out' ELSE 'in' END AS dir,
              r.name AS relName, r.fact AS fact, r.created_at AS created,
              r.valid_at AS valid, r.expired_at AS expired, r.uuid AS uuid
         RETURN dir, relName, fact, other.name AS otherName, created, valid, expired, uuid`,
        { keepName, mergeName }
      );

      let count = 0;
      for (const t of transferred) {
        const newFact = (t.fact || "").replace(new RegExp(mergeName, "gi"), keepName);
        if (t.dir === "out") {
          await query(driver,
            `MATCH (k:Entity {name: $keepName}), (o:Entity {name: $otherName})
             CREATE (k)-[:RELATES_TO {name: $relName, fact: $fact, created_at: datetime(), uuid: randomUUID(), group_id: "", episodes: []}]->(o)`,
            { keepName, otherName: t.otherName, relName: t.relName, fact: newFact }
          );
        } else {
          await query(driver,
            `MATCH (o:Entity {name: $otherName}), (k:Entity {name: $keepName})
             CREATE (o)-[:RELATES_TO {name: $relName, fact: $fact, created_at: datetime(), uuid: randomUUID(), group_id: "", episodes: []}]->(k)`,
            { keepName, otherName: t.otherName, relName: t.relName, fact: newFact }
          );
        }
        count++;
      }

      // Update summary/group if provided
      if (newSummary !== undefined || newGroup) {
        const sets = [];
        const params = { keepName };
        if (newSummary !== undefined) { sets.push("e.summary = $summary"); params.summary = newSummary; }
        if (newGroup) { sets.push("e.category = $category"); params.category = newGroup; }
        if (sets.length > 0) {
          await query(driver, `MATCH (e:Entity {name: $keepName}) SET ${sets.join(", ")}`, params);
        }
      }

      // Delete merged entity
      await query(driver, `MATCH (e:Entity {name: $mergeName}) DETACH DELETE e`, { mergeName });

      logger?.info?.(`MindReader: merged "${mergeName}" into "${keepName}" (${count} rels transferred)`);
      res.json({ ok: true, kept: keepName, deleted: mergeName, transferred: count });
    } catch (err) {
      logger?.error?.(`Merge error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/link — Create a new relationship between two entities
   */
  app.post("/api/link", async (req, res) => {
    try {
      const { sourceName, targetName, relationName, fact } = req.body;
      if (!sourceName || !targetName || !relationName) {
        return res.status(400).json({ error: "Missing sourceName, targetName, or relationName" });
      }

      // Verify both entities exist before creating the link
      const entities = await query(driver,
        `MATCH (s:Entity {name: $sourceName}), (t:Entity {name: $targetName})
         RETURN s.name AS sName, t.name AS tName`,
        { sourceName, targetName }
      );
      if (!entities.length) {
        return res.status(404).json({ error: "One or both entities not found" });
      }

      await query(driver,
        `MATCH (s:Entity {name: $sourceName}), (t:Entity {name: $targetName})
         CREATE (s)-[:RELATES_TO {
           name: $relationName, fact: $fact,
           created_at: datetime(), uuid: randomUUID(),
           group_id: "", episodes: []
         }]->(t)`,
        { sourceName, targetName, relationName, fact: fact || `${sourceName} ${relationName} ${targetName}` }
      );

      logger?.info?.(`MindReader: linked "${sourceName}" -[${relationName}]-> "${targetName}"`);
      res.json({ ok: true, source: sourceName, target: targetName, relation: relationName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/entity/:name/delete-preview — Preview what will be affected by deleting an entity
   */
  app.get("/api/entity/:name/delete-preview", async (req, res) => {
    try {
      const { name } = req.params;

      const entity = await query(driver,
        `MATCH (e:Entity) WHERE toLower(e.name) = toLower($name) RETURN e LIMIT 1`,
        { name }
      );
      if (!entity.length) return res.status(404).json({ error: "Entity not found" });

      const rels = await query(driver,
        `MATCH (e:Entity)-[r:RELATES_TO]-(other:Entity)
         WHERE toLower(e.name) = toLower($name) AND r.expired_at IS NULL
         RETURN r.name AS relation, r.fact AS fact, other.name AS otherName,
                CASE WHEN startNode(r) = e THEN 'outgoing' ELSE 'incoming' END AS direction`,
        { name }
      );

      const episodes = await query(driver,
        `MATCH (e:Entity)-[r:MENTIONS]-(ep:Episodic)
         WHERE toLower(e.name) = toLower($name)
         RETURN count(ep) AS count`,
        { name }
      );

      res.json({
        entity: nodeToPlain(entity[0].e),
        relationships: rels.map(r => ({
          relation: r.relation,
          fact: r.fact,
          otherName: r.otherName,
          direction: r.direction,
        })),
        episodicLinks: episodes[0]?.count?.toNumber?.() || episodes[0]?.count || 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/entity/:name — Delete an entity and all its relationships
   */
  app.delete("/api/entity/:name", async (req, res) => {
    try {
      const { name } = req.params;

      const entity = await query(driver,
        `MATCH (e:Entity) WHERE toLower(e.name) = toLower($name) RETURN e.name AS name`,
        { name }
      );
      if (!entity.length) return res.status(404).json({ error: "Entity not found" });

      const actualName = entity[0].name;

      // Count what will be deleted
      const counts = await query(driver,
        `MATCH (e:Entity {name: $name})
         OPTIONAL MATCH (e)-[r]-()
         RETURN count(r) AS relCount`,
        { name: actualName }
      );

      const relCount = counts[0]?.relCount?.toNumber?.() || counts[0]?.relCount || 0;

      // DETACH DELETE removes node + all relationships
      await query(driver, `MATCH (e:Entity {name: $name}) DETACH DELETE e`, { name: actualName });

      logger?.info?.(`MindReader: deleted entity "${actualName}" (${relCount} relationships removed)`);
      res.json({ ok: true, deleted: actualName, relationshipsRemoved: relCount });
    } catch (err) {
      logger?.error?.(`Delete error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/entity/:name/summary — Update entity summary (user-editable, legacy)
   */
  app.put("/api/entity/:name/summary", async (req, res) => {
    try {
      const { name } = req.params;
      const { summary } = req.body;
      if (summary == null) return res.status(400).json({ error: "Missing summary" });

      await query(driver,
        `MATCH (e:Entity)
         WHERE toLower(e.name) = toLower($name)
         SET e.summary = $summary`,
        { name, summary }
      );

      res.json({ ok: true, entity: name, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
