/**
 * Evolve routes — /api/entity/:name/evolve, /api/entity/:name/evolve/save
 */
import neo4j from "neo4j-driver";
import { query } from "../neo4j.js";
import { EXTRACTION_INSTRUCTIONS } from "../lib/preprocessor.js";
import { synthesizeDetails } from "../lib/details.js";

export function registerRoutes(app, ctx) {
  const { driver, config, logger, mgDaemon } = ctx;

  // Helper: build match clause that supports both uuid and name lookup
  function entityMatch(paramName = "name", alias = "e") {
    return (val) => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
      const idClause = isUuid ? `${alias}.uuid = $${paramName}` : `toLower(${alias}.name) = toLower($${paramName})`;
      return `${alias}.tenantId = $__tenantId AND ${idClause}`;
    };
  }

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
      const { focusQuestion, previousDiscoveries } = req.body || {};
      const prevEntities = Array.isArray(previousDiscoveries?.entities) ? previousDiscoveries.entities : [];
      const prevRelationships = Array.isArray(previousDiscoveries?.relationships) ? previousDiscoveries.relationships : [];
      const roundNumber = (previousDiscoveries?.round || 0) + 1;

      // Fetch entity + connections (same pattern as /summarize)
      const match = entityMatch("name", "start")(name);
      const results = await query(driver,
        `MATCH (start:Entity)
         WHERE ${match}
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

      // Build previous discoveries context for multi-round evolve
      const prevDiscoverySection = prevEntities.length > 0
        ? `\n## Previously Discovered (DO NOT repeat these — from earlier rounds)\nEntities: ${prevEntities.join(", ")}\nRelationships: ${prevRelationships.slice(0, 30).map(r => `${r.source} [${r.label}] ${r.target}`).join("; ")}\n`
        : "";

      sendSSE("round", { round: roundNumber });

      // Phase 1: Internal Discovery — find connections to existing graph entities
      const graphEntities = await query(driver,
        `MATCH (e:Entity)
         WHERE e.tenantId = $__tenantId AND e.expired_at IS NULL AND toLower(e.name) <> toLower($name)
         WITH e, CASE
           WHEN toLower(e.summary) CONTAINS toLower($name) THEN 3
           WHEN ANY(tag IN coalesce(e.tags, []) WHERE toLower(tag) CONTAINS toLower($name)) THEN 2
           ELSE 1
         END AS relevance
         RETURN e.name AS name, e.summary AS summary, e.category AS category, e.tags AS tags, e.details AS details
         ORDER BY relevance DESC, e.created_at DESC LIMIT 50`,
        { name: startNode.name || name }
      );

      const connectedNames = new Set(connected.map(c => c.name?.toLowerCase()));
      const prevNames = new Set(prevEntities.map(n => n.toLowerCase()));
      const unconnectedEntities = graphEntities.filter(e =>
        !connectedNames.has(e.name?.toLowerCase()) && !prevNames.has(e.name?.toLowerCase())
      );

      if (unconnectedEntities.length > 0) {
        sendSSE("phase", { phase: "internal", message: "Discovering internal connections..." });

        const graphEntityList = unconnectedEntities.map(e =>
          `- ${e.name} [${e.category || "other"}]: ${(e.summary || "").slice(0, 150)}${e.details ? " | " + e.details.slice(0, 100) : ""}`
        ).join("\n");

        const internalPrompt = `You are analyzing a knowledge graph. Given a target entity and a list of OTHER entities that exist in the same graph but are NOT yet connected, identify relationships that likely exist between them.

## Target Entity
${entityInfo}

## Already Connected (skip these)
${connectedEntities}
${prevDiscoverySection}
## Other Entities in the Graph (find connections to these)
${graphEntityList}

## Instructions
Based on the entity names, summaries, and details above, identify which of the "Other Entities" have a real relationship to "${startNode.name || name}". Only create relationships where there is clear evidence from the summaries/details — do not guess or fabricate.

## Output Format
For each discovered connection, output:
[REL] {"source": "Source Entity", "target": "Target Entity", "label": "short_label", "fact": "Explanation of the relationship based on known information"}

RULES:
- Only use entity names that EXACTLY match those listed above.
- "source" or "target" MUST be "${startNode.name || name}".
- Only create relationships with clear evidence — do not hallucinate connections.
- Aim for quality over quantity. 3-10 well-evidenced connections is better than 20 guesses.`;

        try {
          const { callLLM } = await import("../lib/llm.js");
          const internalResult = await callLLM({
            prompt: internalPrompt,
            config: { ...config, llmModel: config.llmEvolveModel || config.llmModel },
            jsonMode: false,
            timeoutMs: 30000,
            temperature: 0.2,
            maxTokens: 4000,
          });

          // Parse [REL] lines from internal discovery
          const lines = (internalResult || "").split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("[REL]")) {
              try {
                const json = JSON.parse(trimmed.slice(5).trim());
                sendSSE("relationship", json);
                sendSSE("token", { text: `Internal: ${json.source} → ${json.target} (${json.label})\n` });
              } catch { /* skip malformed */ }
            }
          }
        } catch (err) {
          logger?.warn?.(`Evolve internal discovery failed: ${err.message}`);
        }

        sendSSE("phase", { phase: "external", message: "Researching external knowledge..." });
      }

      const sanitizedFocus = (focusQuestion || "").slice(0, 500);
      const taskSection = sanitizedFocus
        ? `Research focus: ${sanitizedFocus}`
        : "Research this entity broadly. Discover important facts, related people, organizations, events, locations, and other entities.";

      // Include unconnected graph entities in the external prompt so LLM can connect to them
      const graphContextSection = unconnectedEntities.length > 0
        ? `\n## Other Entities in the Graph (connect to these if relevant)\n${unconnectedEntities.slice(0, 20).map(e => `- ${e.name} (${e.category || "other"})`).join("\n")}\n`
        : "";

      const llmPrompt = `You are an internet research specialist. Your task is to **search the web** for real-world information about "${startNode.name || name}" and bring back NEW facts, context, and connections that are NOT already in the knowledge graph.

## Target Entity
${entityInfo}

## Already Known (DO NOT repeat these)
${connectionsInfo}

## Already Connected Entities (DO NOT rediscover these)
${connectedEntities}
${prevDiscoverySection}${graphContextSection}
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
- If you discover a connection to an entity listed in "Other Entities in the Graph", use its EXACT name — do NOT create a duplicate.

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
               tenantId: $__tenantId,
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
   * POST /api/entity/:name/evolve/save — Save evolved discoveries via the store pipeline.
   *
   * Instead of raw Cypher entity/relationship creation, we:
   * 1. Drop orphan entities (no relationships -> never should have been discovered)
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

      // Synthesize details from evolved content
      try {
        const saveMatch = entityMatch("name")(targetName);
        const entityData = await query(driver,
          `MATCH (e:Entity) WHERE ${saveMatch}
           RETURN e.details AS details, e.summary AS summary, e.category AS category, e.tags AS tags`,
          { name: targetName }
        );
        if (entityData.length > 0) {
          const ent = entityData[0];
          const evolveFacts = (entities || []).map(e =>
            `${e.name}: ${e.summary || ""}`
          ).join("\n") + "\n" + (relationships || []).map(rel =>
            `${rel.source} ${rel.type} ${rel.target}`
          ).join("\n");

          const synthesized = await synthesizeDetails({
            entityName: targetName,
            existingDetails: ent.details || "",
            existingSummary: ent.summary || "",
            newFacts: evolveFacts,
            category: ent.category || "other",
            tags: ent.tags || [],
            config,
          });

          await query(driver,
            `MATCH (e:Entity) WHERE ${saveMatch}
             SET e.details = $details, e.summary = $summary`,
            { name: targetName, details: synthesized.details, summary: synthesized.summary }
          );
        }
      } catch (err) {
        logger?.warn?.(`Details synthesis after evolve failed: ${err.message}`);
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
}
