#!/usr/bin/env node
/**
 * Seed demo data for MindReader screenshots.
 * All demo entities/rels get tag "source:demo" for easy cleanup.
 *
 * Usage:
 *   node scripts/seed-demo.mjs          # seed
 *   node scripts/seed-demo.mjs --clean  # remove all demo data
 */

const NEO4J_PORT = process.env.NEO4J_PORT || "7474";
const NEO4J_PASS = process.env.NEO4J_PASS || "changeme";
const NEO4J_URL = `http://localhost:${NEO4J_PORT}/db/neo4j/tx/commit`;
const AUTH = "Basic " + Buffer.from(`neo4j:${NEO4J_PASS}`).toString("base64");

async function cypher(statement, params = {}) {
  const res = await fetch(NEO4J_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: AUTH },
    body: JSON.stringify({ statements: [{ statement, parameters: params }] }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.results[0];
}

// ── Demo entities — fully fictional, safe for public screenshots ──
const entities = [
  // People (fictional)
  { name: "Alex Mercer", category: "person", summary: "Lead architect at Nexora Labs. Designed the Prism engine and oversees the Orion model family.", tags: ["ai", "architecture", "nexora"] },
  { name: "Suki Tanaka", category: "person", summary: "Co-founder of Vectrix. Pioneered cascade training methods that reduced model hallucinations by 40%.", tags: ["ml-research", "training", "vectrix"] },
  { name: "Ravi Deshmukh", category: "person", summary: "Director of Applied AI at Heliograph. Built the real-time translation pipeline used across 30+ languages.", tags: ["nlp", "translation", "heliograph"] },
  { name: "Elena Vasquez", category: "person", summary: "Professor of Computational Neuroscience at Ridgemont University. Leads the Synaptic AI Lab.", tags: ["neuroscience", "academia", "research"] },
  { name: "Marcus Holt", category: "person", summary: "CEO of Stratos Computing. Pivoted the company from cloud storage to GPU-as-a-service for AI training.", tags: ["infrastructure", "gpu", "leadership"] },
  { name: "Lin Wei", category: "person", summary: "Open-source maintainer of the Foxglove framework. Former research scientist at Nexora Labs.", tags: ["open-source", "frameworks", "community"] },
  { name: "Dr. Amara Obi", category: "person", summary: "AI Ethics Lead at the Meridian Institute. Published the influential 'Guardrails Framework' for responsible AI.", tags: ["ethics", "policy", "ai-safety"] },
  { name: "Jordan Blake", category: "person", summary: "Staff engineer at Vectrix. Created the MemoryWeave library for persistent agent memory.", tags: ["engineering", "memory-systems", "agents"] },

  // Organizations (fictional)
  { name: "Nexora Labs", category: "organization", summary: "AI research company known for the Orion model family and Prism inference engine. Founded in 2021 in Ashford.", tags: ["ai", "research", "llm"] },
  { name: "Vectrix", category: "organization", summary: "Applied AI startup specializing in agentic workflows and long-term memory systems for AI assistants.", tags: ["agents", "memory", "startup"] },
  { name: "Heliograph", category: "organization", summary: "Enterprise AI company providing real-time NLP solutions. Known for their multilingual Compass model.", tags: ["nlp", "enterprise", "translation"] },
  { name: "Stratos Computing", category: "organization", summary: "Cloud infrastructure provider focused on GPU clusters for AI training. Operates data centers in three regions.", tags: ["cloud", "gpu", "infrastructure"] },
  { name: "Meridian Institute", category: "organization", summary: "Independent AI governance and ethics research institute. Publishes annual State of AI Safety reports.", tags: ["ethics", "governance", "research"] },
  { name: "Foxglove Foundation", category: "organization", summary: "Open-source foundation maintaining the Foxglove ML framework and community model hub.", tags: ["open-source", "community", "ml-ops"] },
  { name: "Ridgemont University", category: "organization", summary: "Research university with a top-ranked AI program. Home to the Synaptic AI Lab and Distributed Systems Group.", tags: ["academia", "research", "education"] },

  // Projects (fictional)
  { name: "Orion-7", category: "project", summary: "Nexora's flagship multimodal model. 200B parameters, 256k context window, state-of-the-art on reasoning benchmarks.", tags: ["llm", "multimodal", "nexora"] },
  { name: "Compass", category: "project", summary: "Heliograph's multilingual language model. Supports 45 languages with near-native fluency and real-time streaming.", tags: ["nlp", "multilingual", "heliograph"] },
  { name: "MemoryWeave", category: "project", summary: "Open-source library for building persistent, evolving memory graphs for AI agents. Uses temporal knowledge graphs.", tags: ["memory", "knowledge-graph", "agents"] },
  { name: "Foxglove", category: "tool", summary: "Open-source deep learning framework focused on simplicity and composability. Growing alternative to established frameworks.", tags: ["framework", "deep-learning", "open-source"] },
  { name: "Cascade Training", category: "concept", summary: "Multi-stage training methodology where models learn from progressively refined datasets to reduce hallucinations.", tags: ["training", "methodology", "alignment"] },
  { name: "Prism Engine", category: "tool", summary: "Nexora's high-performance inference engine. Optimized for serving large models with sub-100ms latency at scale.", tags: ["inference", "performance", "serving"] },
  { name: "SynapticDB", category: "tool", summary: "Graph database designed specifically for AI memory systems. Native temporal queries and vector similarity search.", tags: ["database", "graph", "memory"] },
  { name: "ArcticStore", category: "tool", summary: "Stratos Computing's distributed storage layer for training data. Handles petabyte-scale datasets with streaming access.", tags: ["storage", "distributed", "training-data"] },

  // Concepts
  { name: "Temporal Knowledge Graph", category: "concept", summary: "Knowledge graph that tracks how facts and relationships change over time. Enables AI agents to reason about evolving information.", tags: ["graph", "temporal", "memory"] },
  { name: "Agentic Memory", category: "concept", summary: "Persistent memory architecture for AI agents that captures, organizes, and retrieves knowledge across conversations.", tags: ["agents", "memory", "architecture"] },
  { name: "Guardrails Framework", category: "concept", summary: "A set of principles and technical constraints for building AI systems that behave within defined safety boundaries.", tags: ["safety", "alignment", "governance"] },
  { name: "Retrieval-Augmented Generation", category: "concept", summary: "Architecture combining language models with external knowledge retrieval. Reduces hallucinations by grounding responses in facts.", tags: ["rag", "architecture", "retrieval"] },
  { name: "Context Distillation", category: "concept", summary: "Technique for compressing long conversation histories into dense representations without losing critical information.", tags: ["compression", "context", "efficiency"] },

  // Events (fictional)
  { name: "Nexora DevCon 2025", category: "event", summary: "Annual developer conference where Nexora unveiled Orion-7 and the Prism Engine v3. Held in Ashford, October 2025.", tags: ["conference", "nexora", "2025"] },
  { name: "AI Safety Summit Zurich", category: "event", summary: "Global summit on AI governance. 40 countries endorsed the Meridian Accord on responsible AI development.", tags: ["governance", "policy", "summit"] },

  // Locations (fictional)
  { name: "Ashford", category: "location", summary: "Tech hub in the Pacific Northwest. Home to Nexora Labs, Stratos Computing, and a growing AI startup ecosystem.", tags: ["tech-hub", "startups"] },
  { name: "Bridgewater Innovation District", category: "location", summary: "Research campus housing Vectrix, Foxglove Foundation, and Ridgemont University's AI programs.", tags: ["research-campus", "innovation"] },
];

// ── Demo relationships ─────────────────────────────────────
const relationships = [
  // People → Organizations
  { source: "Alex Mercer", target: "Nexora Labs", label: "leads", fact: "Alex Mercer is the lead architect at Nexora Labs" },
  { source: "Suki Tanaka", target: "Vectrix", label: "co-founded", fact: "Suki Tanaka co-founded Vectrix and leads their research division" },
  { source: "Ravi Deshmukh", target: "Heliograph", label: "directs_ai", fact: "Ravi Deshmukh is the Director of Applied AI at Heliograph" },
  { source: "Elena Vasquez", target: "Ridgemont University", label: "professor_at", fact: "Elena Vasquez leads the Synaptic AI Lab at Ridgemont University" },
  { source: "Marcus Holt", target: "Stratos Computing", label: "leads", fact: "Marcus Holt is the CEO of Stratos Computing" },
  { source: "Lin Wei", target: "Foxglove Foundation", label: "maintains", fact: "Lin Wei is the primary maintainer of the Foxglove framework" },
  { source: "Dr. Amara Obi", target: "Meridian Institute", label: "leads_ethics", fact: "Dr. Amara Obi is the AI Ethics Lead at the Meridian Institute" },
  { source: "Jordan Blake", target: "Vectrix", label: "engineers_at", fact: "Jordan Blake is a staff engineer at Vectrix" },
  { source: "Lin Wei", target: "Nexora Labs", label: "formerly_at", fact: "Lin Wei was a research scientist at Nexora Labs before joining Foxglove" },

  // Organizations → Projects
  { source: "Nexora Labs", target: "Orion-7", label: "developed", fact: "Nexora Labs developed the Orion-7 multimodal language model" },
  { source: "Nexora Labs", target: "Prism Engine", label: "created", fact: "Nexora Labs created the Prism inference engine for model serving" },
  { source: "Heliograph", target: "Compass", label: "built", fact: "Heliograph built the Compass multilingual language model" },
  { source: "Vectrix", target: "MemoryWeave", label: "open-sourced", fact: "Vectrix developed and open-sourced the MemoryWeave library" },
  { source: "Stratos Computing", target: "ArcticStore", label: "developed", fact: "Stratos Computing developed ArcticStore for petabyte-scale training data" },
  { source: "Foxglove Foundation", target: "Foxglove", label: "maintains", fact: "The Foxglove Foundation maintains the open-source Foxglove ML framework" },

  // People → Projects
  { source: "Alex Mercer", target: "Prism Engine", label: "designed", fact: "Alex Mercer designed the architecture of the Prism inference engine" },
  { source: "Suki Tanaka", target: "Cascade Training", label: "pioneered", fact: "Suki Tanaka pioneered the Cascade Training methodology at Vectrix" },
  { source: "Jordan Blake", target: "MemoryWeave", label: "created", fact: "Jordan Blake created the MemoryWeave library for persistent agent memory" },
  { source: "Elena Vasquez", target: "SynapticDB", label: "advised", fact: "Elena Vasquez served as technical advisor for the SynapticDB project" },

  // Concepts → Concepts
  { source: "Temporal Knowledge Graph", target: "Agentic Memory", label: "enables", fact: "Temporal knowledge graphs provide the foundation for agentic memory systems" },
  { source: "Retrieval-Augmented Generation", target: "Temporal Knowledge Graph", label: "leverages", fact: "RAG systems can leverage temporal knowledge graphs for time-aware retrieval" },
  { source: "Guardrails Framework", target: "Cascade Training", label: "informs", fact: "The Guardrails Framework principles inform the safety stages of Cascade Training" },
  { source: "Context Distillation", target: "Agentic Memory", label: "optimizes", fact: "Context distillation optimizes how agentic memory stores long conversation histories" },

  // Projects → Concepts
  { source: "MemoryWeave", target: "Temporal Knowledge Graph", label: "implements", fact: "MemoryWeave implements temporal knowledge graphs for AI agent memory" },
  { source: "MemoryWeave", target: "SynapticDB", label: "uses", fact: "MemoryWeave uses SynapticDB as its graph storage backend" },
  { source: "Orion-7", target: "Cascade Training", label: "trained_with", fact: "Orion-7 was trained using the Cascade Training methodology" },
  { source: "Orion-7", target: "Retrieval-Augmented Generation", label: "supports", fact: "Orion-7 has native support for retrieval-augmented generation" },
  { source: "Compass", target: "Context Distillation", label: "uses", fact: "Compass uses context distillation for efficient multilingual processing" },

  // People → Concepts
  { source: "Dr. Amara Obi", target: "Guardrails Framework", label: "published", fact: "Dr. Amara Obi published the influential Guardrails Framework for responsible AI" },
  { source: "Elena Vasquez", target: "Agentic Memory", label: "researches", fact: "Elena Vasquez's lab at Ridgemont researches computational models of agentic memory" },

  // Events
  { source: "Nexora DevCon 2025", target: "Orion-7", label: "unveiled", fact: "Orion-7 was unveiled at Nexora DevCon 2025 in Ashford" },
  { source: "Nexora DevCon 2025", target: "Prism Engine", label: "announced", fact: "Prism Engine v3 was announced at Nexora DevCon 2025" },
  { source: "AI Safety Summit Zurich", target: "Guardrails Framework", label: "endorsed", fact: "The AI Safety Summit in Zurich endorsed the Guardrails Framework principles" },
  { source: "AI Safety Summit Zurich", target: "Meridian Institute", label: "hosted_by", fact: "The AI Safety Summit was co-organized by the Meridian Institute" },

  // Locations
  { source: "Nexora Labs", target: "Ashford", label: "headquartered_in", fact: "Nexora Labs is headquartered in Ashford" },
  { source: "Stratos Computing", target: "Ashford", label: "headquartered_in", fact: "Stratos Computing is headquartered in Ashford" },
  { source: "Vectrix", target: "Bridgewater Innovation District", label: "located_in", fact: "Vectrix is located in the Bridgewater Innovation District" },
  { source: "Ridgemont University", target: "Bridgewater Innovation District", label: "located_in", fact: "Ridgemont University's AI campus is in the Bridgewater Innovation District" },
  { source: "Foxglove Foundation", target: "Bridgewater Innovation District", label: "located_in", fact: "The Foxglove Foundation is based in the Bridgewater Innovation District" },

  // Cross-cutting
  { source: "Foxglove", target: "Stratos Computing", label: "runs_on", fact: "Foxglove's model hub runs on Stratos Computing GPU infrastructure" },
  { source: "Foxglove Foundation", target: "MemoryWeave", label: "hosts", fact: "Foxglove Foundation hosts MemoryWeave packages on their model hub" },
  { source: "Marcus Holt", target: "Nexora Labs", label: "invested_in", fact: "Marcus Holt was an early investor in Nexora Labs through Stratos Ventures" },
];

async function seed() {
  console.log("Seeding demo data...\n");

  // Create entities in batch
  await cypher(
    `UNWIND $entities AS ent
     OPTIONAL MATCH (existing:Entity) WHERE toLower(existing.name) = toLower(ent.name)
     WITH ent, existing WHERE existing IS NULL
     CREATE (e:Entity {
       name: ent.name,
       summary: ent.summary,
       group_id: ent.category,
       tags: ent.tags + ["source:demo"],
       created_at: datetime(),
       uuid: randomUUID()
     })
     RETURN count(e) AS created`,
    { entities }
  );
  const countResult = await cypher(
    `MATCH (e:Entity) WHERE "source:demo" IN e.tags RETURN count(e) AS cnt`
  );
  const entityCount = countResult.data[0]?.row[0] || 0;
  console.log(`  Entities: ${entityCount} demo nodes`);

  // Create relationships in batch
  await cypher(
    `UNWIND $rels AS rel
     MATCH (s:Entity) WHERE toLower(s.name) = toLower(rel.source)
     MATCH (t:Entity) WHERE toLower(t.name) = toLower(rel.target)
     CREATE (s)-[:RELATES_TO {
       name: rel.label,
       fact: rel.fact,
       created_at: datetime(),
       uuid: randomUUID(),
       demo: true
     }]->(t)
     RETURN count(*) AS created`,
    { rels: relationships }
  );
  const relResult = await cypher(
    `MATCH ()-[r:RELATES_TO {demo: true}]->() RETURN count(r) AS cnt`
  );
  const relCount = relResult.data[0]?.row[0] || 0;
  console.log(`  Relationships: ${relCount} demo edges`);

  console.log("\nDone! Open http://localhost:18900 to see the graph.");
  console.log("Run with --clean to remove all demo data.");
}

async function clean() {
  console.log("Removing demo data...\n");

  // Remove demo relationships first
  const relResult = await cypher(
    `MATCH ()-[r:RELATES_TO {demo: true}]->() DELETE r RETURN count(r) AS deleted`
  );
  console.log(`  Deleted ${relResult.data[0]?.row[0] || 0} demo relationships`);

  // Remove demo entities
  const entResult = await cypher(
    `MATCH (e:Entity) WHERE "source:demo" IN e.tags DETACH DELETE e RETURN count(e) AS deleted`
  );
  console.log(`  Deleted ${entResult.data[0]?.row[0] || 0} demo entities`);

  console.log("\nCleanup complete.");
}

const isClean = process.argv.includes("--clean");
(isClean ? clean : seed)().catch(err => { console.error(err); process.exit(1); });
