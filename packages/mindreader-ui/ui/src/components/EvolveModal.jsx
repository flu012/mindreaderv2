import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import Graph from "graphology";
import Sigma from "sigma";
import { CATEGORY_COLORS } from "../constants";

// ForceAtlas2 — use synchronous layout since we have few nodes
let forceAtlas2Layout = null;
import("graphology-layout-forceatlas2").then(mod => {
  forceAtlas2Layout = mod.default || mod;
}).catch(() => {
  console.warn("graphology-layout-forceatlas2 not available, using random layout");
});

function getCategoryColor(category) {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.other || "#6688aa";
}

export default function EvolveModal({ entityName, onClose, onSaved }) {
  const [phase, setPhase] = useState("input"); // "input" | "streaming" | "review"
  const [focusQuestion, setFocusQuestion] = useState("");
  // Feed items: interleaved array of { type: "text"|"entity"|"relationship", data: ... }
  const [feedItems, setFeedItems] = useState([]);
  const [entities, setEntities] = useState([]);
  const [relationships, setRelationships] = useState([]);
  const [checkedEntities, setCheckedEntities] = useState(new Set());
  const [checkedRels, setCheckedRels] = useState(new Set());
  const [tokenInfo, setTokenInfo] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null); // { name, category, summary, tags, x, y }
  const [currentRound, setCurrentRound] = useState(0);
  const [allDiscoveredEntities, setAllDiscoveredEntities] = useState([]); // names across all rounds
  const [allDiscoveredRels, setAllDiscoveredRels] = useState([]); // {source,target,label} across all rounds

  const abortRef = useRef(null);
  const saveTimerRef = useRef(null);
  const feedRef = useRef(null);
  const graphContainerRef = useRef(null);
  const sigmaRef = useRef(null);
  const graphRef = useRef(null);

  // Auto-scroll feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [feedItems]);

  // Cleanup save timer and abort controller on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // Initialize mini-graph
  useEffect(() => {
    if (!graphContainerRef.current) return;

    const graph = new Graph();
    graphRef.current = graph;

    // Add target node at center
    graph.addNode(entityName, {
      label: entityName,
      x: 0,
      y: 0,
      size: 14,
      color: "#4affff",
      type: "circle",
      _category: "target",
      _summary: "",
      _tags: [],
    });

    const sigma = new Sigma(graph, graphContainerRef.current, {
      renderLabels: true,
      labelSize: 11,
      labelColor: { color: "#ffffff" },
      labelFont: "Inter, system-ui, sans-serif",
      defaultEdgeType: "line",
      defaultEdgeColor: "#ffffff33",
      enableEdgeEvents: false,
      allowInvalidContainer: true,
    });
    sigmaRef.current = sigma;

    // Hover events for tooltip
    sigma.on("enterNode", ({ node }) => {
      const attrs = graph.getNodeAttributes(node);
      const viewportPos = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
      setHoveredNode({
        name: node,
        category: attrs._category || "",
        summary: attrs._summary || "",
        tags: attrs._tags || [],
        x: viewportPos.x,
        y: viewportPos.y,
      });
    });
    sigma.on("leaveNode", () => {
      setHoveredNode(null);
    });

    return () => {
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [entityName]);

  // Apply layout when new nodes are added
  const applyLayout = useCallback(() => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma || graph.order < 2) return;

    if (forceAtlas2Layout) {
      try {
        forceAtlas2Layout.assign(graph, {
          iterations: 50,
          settings: {
            gravity: 1,
            scalingRatio: 3,
            barnesHutOptimize: false,
          },
        });
      } catch {
        // Fallback: random layout around center
        randomLayout(graph);
      }
    } else {
      randomLayout(graph);
    }
    sigma.refresh();
  }, []);

  function randomLayout(graph) {
    let i = 0;
    graph.forEachNode((node, attrs) => {
      if (node === entityName) return; // keep target at center
      const angle = (i / (graph.order - 1)) * 2 * Math.PI;
      const radius = 2 + Math.random();
      graph.setNodeAttribute(node, "x", Math.cos(angle) * radius);
      graph.setNodeAttribute(node, "y", Math.sin(angle) * radius);
      i++;
    });
  }

  // Add entity to mini-graph
  const addEntityToGraph = useCallback((ent) => {
    const graph = graphRef.current;
    if (!graph || graph.hasNode(ent.name)) return;

    const angle = Math.random() * 2 * Math.PI;
    const radius = 2 + Math.random();
    graph.addNode(ent.name, {
      label: ent.name,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      size: 8,
      color: getCategoryColor(ent.category),
      _category: ent.category || "",
      _summary: ent.summary || "",
      _tags: ent.tags || [],
    });
    applyLayout();
  }, [applyLayout]);

  // Add relationship to mini-graph
  const addRelToGraph = useCallback((rel) => {
    const graph = graphRef.current;
    if (!graph) return;
    const srcExists = graph.hasNode(rel.source);
    const tgtExists = graph.hasNode(rel.target);
    if (!srcExists || !tgtExists) return;

    const edgeId = `${rel.source}-${rel.target}-${rel.label}`;
    if (graph.hasEdge(edgeId)) return;

    try {
      graph.addEdgeWithKey(edgeId, rel.source, rel.target, {
        label: rel.label || "",
        size: 1.5,
        color: "rgba(255,255,255,0.3)",
      });
      sigmaRef.current?.refresh();
    } catch { /* edge may already exist */ }
  }, []);

  // Start evolution
  const handleEvolve = useCallback(async () => {
    setPhase("streaming");
    setFeedItems([]);
    setEntities([]);
    setRelationships([]);
    setCheckedEntities(new Set());
    setCheckedRels(new Set());
    setTokenInfo(null);
    setError(null);

    const abortCtrl = new AbortController();
    abortRef.current = abortCtrl;

    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entityName)}/evolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          focusQuestion: focusQuestion.trim() || undefined,
          previousDiscoveries: currentRound > 0 ? {
            entities: allDiscoveredEntities,
            relationships: allDiscoveredRels,
            round: currentRound,
          } : undefined,
        }),
        signal: abortCtrl.signal,
      });

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      const discoveredEntities = [];
      const discoveredRels = [];
      const entityChecks = new Set();
      const relChecks = new Set();
      const items = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const messages = sseBuffer.split("\n\n");
        sseBuffer = messages.pop(); // keep incomplete message

        for (const msg of messages) {
          const eventMatch = msg.match(/^event:\s*(.+)$/m);
          const dataMatch = msg.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;

          const event = eventMatch[1].trim();
          let data;
          try { data = JSON.parse(dataMatch[1]); } catch { continue; }

          switch (event) {
            case "token":
              // Update the last text item in real-time for smooth streaming
              if (items.length > 0 && items[items.length - 1].type === "text") {
                items[items.length - 1].data += data.text;
              } else {
                items.push({ type: "text", data: data.text });
              }
              setFeedItems([...items]);
              break;
            case "entity": {
              const idx = discoveredEntities.length;
              discoveredEntities.push(data);
              entityChecks.add(idx);
              items.push({ type: "entity", data, idx });
              setFeedItems([...items]);
              setEntities([...discoveredEntities]);
              setCheckedEntities(new Set(entityChecks));
              addEntityToGraph(data);
              break;
            }
            case "relationship": {
              const idx = discoveredRels.length;
              discoveredRels.push(data);
              relChecks.add(idx);
              items.push({ type: "relationship", data, idx });
              setFeedItems([...items]);
              setRelationships([...discoveredRels]);
              setCheckedRels(new Set(relChecks));
              addRelToGraph(data);
              break;
            }
            case "round":
              items.push({ type: "round", data });
              setFeedItems([...items]);
              setCurrentRound(data.round);
              break;
            case "phase":
              items.push({ type: "phase", data });
              setFeedItems([...items]);
              break;
            case "done":
              setTokenInfo(data);
              break;
            case "error":
              setError(data.message);
              break;
          }
        }
      }

      setPhase("review");

      // Accumulate discoveries for multi-round context
      setAllDiscoveredEntities(prev => [...prev, ...discoveredEntities.map(e => e.name)]);
      setAllDiscoveredRels(prev => [...prev, ...discoveredRels.map(r => ({ source: r.source, target: r.target, label: r.label }))]);
    } catch (err) {
      if (err.name === "AbortError") {
        // User stopped — show partial results for review
        setPhase("review");
      } else {
        setError(err.message);
        setPhase("review");
      }
    }
  }, [entityName, focusQuestion, addEntityToGraph, addRelToGraph, currentRound, allDiscoveredEntities, allDiscoveredRels]);

  // Stop streaming
  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  // Run another round (appends to existing discoveries)
  const handleNextRound = useCallback(async () => {
    setPhase("streaming");
    setError(null);
    setTokenInfo(null);

    const abortCtrl = new AbortController();
    abortRef.current = abortCtrl;

    // Build previous discoveries from current accumulated state
    const prevEntNames = [...allDiscoveredEntities, ...entities.map(e => e.name)];
    const prevRels = [...allDiscoveredRels, ...relationships.map(r => ({ source: r.source, target: r.target, label: r.label }))];
    const nextRound = currentRound;

    // Accumulate before starting new round
    setAllDiscoveredEntities(prevEntNames);
    setAllDiscoveredRels(prevRels);

    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entityName)}/evolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          focusQuestion: focusQuestion.trim() || undefined,
          previousDiscoveries: {
            entities: prevEntNames,
            relationships: prevRels,
            round: nextRound,
          },
        }),
        signal: abortCtrl.signal,
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      // Keep existing items and append to them
      const items = [...feedItems];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const messages = sseBuffer.split("\n\n");
        sseBuffer = messages.pop();

        for (const msg of messages) {
          const eventMatch = msg.match(/^event:\s*(.+)$/m);
          const dataMatch = msg.match(/^data:\s*(.+)$/m);
          if (!eventMatch || !dataMatch) continue;

          const event = eventMatch[1].trim();
          let data;
          try { data = JSON.parse(dataMatch[1]); } catch { continue; }

          switch (event) {
            case "token":
              if (items.length > 0 && items[items.length - 1].type === "text") {
                items[items.length - 1].data += data.text;
              } else {
                items.push({ type: "text", data: data.text });
              }
              setFeedItems([...items]);
              break;
            case "entity": {
              const idx = entities.length;
              entities.push(data);
              setEntities([...entities]);
              setCheckedEntities(prev => new Set([...prev, idx]));
              items.push({ type: "entity", data, idx });
              setFeedItems([...items]);
              addEntityToGraph(data);
              break;
            }
            case "relationship": {
              const idx = relationships.length;
              relationships.push(data);
              setRelationships([...relationships]);
              setCheckedRels(prev => new Set([...prev, idx]));
              items.push({ type: "relationship", data, idx });
              setFeedItems([...items]);
              addRelToGraph(data);
              break;
            }
            case "round":
              items.push({ type: "round", data });
              setFeedItems([...items]);
              setCurrentRound(data.round);
              break;
            case "phase":
              items.push({ type: "phase", data });
              setFeedItems([...items]);
              break;
            case "done":
              setTokenInfo(data);
              break;
            case "error":
              setError(data.message);
              break;
          }
        }
      }

      setPhase("review");
    } catch (err) {
      if (err.name !== "AbortError") setError(err.message);
      setPhase("review");
    }
  }, [entityName, focusQuestion, entities, relationships, feedItems, allDiscoveredEntities, allDiscoveredRels, currentRound, addEntityToGraph, addRelToGraph]);

  // Toggle checks — also update mini-graph node appearance
  const toggleEntity = (idx) => {
    setCheckedEntities(prev => {
      const next = new Set(prev);
      const wasChecked = next.has(idx);
      wasChecked ? next.delete(idx) : next.add(idx);

      // Grey out / restore node in mini-graph
      const graph = graphRef.current;
      const ent = entities[idx];
      if (graph && ent && graph.hasNode(ent.name)) {
        graph.setNodeAttribute(ent.name, "color", wasChecked ? "#444" : getCategoryColor(ent.category));
        sigmaRef.current?.refresh();
      }

      return next;
    });
  };

  const toggleRel = (idx) => {
    setCheckedRels(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  // Save
  const handleSave = useCallback(async (saveAll = false) => {
    setSaving(true);
    setError(null);

    const selectedEntities = saveAll
      ? entities
      : entities.filter((_, i) => checkedEntities.has(i));
    const selectedRels = saveAll
      ? relationships
      : relationships.filter((_, i) => checkedRels.has(i));

    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entityName)}/evolve/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entities: selectedEntities,
          relationships: selectedRels,
        }),
      });

      if (!res.ok) throw new Error("Save failed");
      const result = await res.json();
      setSaveResult(result);

      // Close after brief delay to show result
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        if (onSaved) onSaved(result);
        onClose();
      }, 1500);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }, [entities, relationships, checkedEntities, checkedRels, entityName, onSaved, onClose]);

  const totalChecked = checkedEntities.size + checkedRels.size;
  const totalItems = entities.length + relationships.length;
  const allChecked = totalChecked === totalItems;

  return createPortal(
    <div className="evolve-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && phase !== "streaming") onClose(); }}>
      <div className="evolve-modal">
        {/* Header */}
        <div className="evolve-modal-header">
          <span className="evolve-modal-title">Evolve: {entityName}</span>
          <button
            className="evolve-modal-close"
            onClick={phase === "streaming" ? handleStop : onClose}
          >
            {phase === "streaming" ? "Stop" : "✕"}
          </button>
        </div>

        {/* Main content */}
        <div className="evolve-modal-body">
          {/* Left: Mini-graph */}
          <div className="evolve-modal-graph" style={{ position: "relative" }}>
            <div ref={graphContainerRef} style={{ width: "100%", height: "100%" }} />
            {hoveredNode && (
              <div style={{
                position: "absolute",
                left: hoveredNode.x + 12,
                top: hoveredNode.y - 10,
                background: "rgba(20, 22, 30, 0.95)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: 8,
                padding: "8px 12px",
                maxWidth: 260,
                pointerEvents: "none",
                zIndex: 50,
                boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
              }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: "#fff", marginBottom: 4 }}>
                  {hoveredNode.name}
                </div>
                {hoveredNode.category && (
                  <div style={{ fontSize: 10, color: getCategoryColor(hoveredNode.category), marginBottom: 3 }}>
                    {hoveredNode.category}
                  </div>
                )}
                {hoveredNode.summary && (
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", lineHeight: 1.4, marginBottom: 3 }}>
                    {hoveredNode.summary.length > 150 ? hoveredNode.summary.slice(0, 150) + "..." : hoveredNode.summary}
                  </div>
                )}
                {hoveredNode.tags?.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 2 }}>
                    {hoveredNode.tags.slice(0, 5).map(tag => (
                      <span key={tag} style={{
                        fontSize: 9, padding: "1px 6px", borderRadius: 8,
                        background: "rgba(74,158,255,0.15)", color: "rgba(74,158,255,0.8)",
                      }}>{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Stream feed + cards */}
          <div className="evolve-modal-feed" ref={feedRef}>
            {phase === "input" && (
              <div className="evolve-input-section">
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
                  Evolve will search the web to discover new entities and relationships connected to <strong style={{ color: "var(--text-primary)" }}>{entityName}</strong>.
                </div>
                <input
                  type="text"
                  className="evolve-focus-input"
                  placeholder="Leave blank for broad research, or type a focus question..."
                  value={focusQuestion}
                  onChange={(e) => setFocusQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleEvolve(); }}
                  autoFocus
                />
                <button className="evolve-start-btn" onClick={handleEvolve}>
                  Evolve
                </button>
              </div>
            )}

            {(phase === "streaming" || phase === "review") && (
              <>
                {/* Interleaved feed: text blocks, entity cards, relationship cards */}
                {feedItems.map((item, fi) => {
                  if (item.type === "text") {
                    return (
                      <div key={`t-${fi}`} className="evolve-stream-text">
                        {item.data}
                      </div>
                    );
                  }
                  if (item.type === "entity") {
                    const ent = item.data;
                    const idx = item.idx;
                    return (
                      <div key={`e-${idx}`} className={`evolve-card evolve-card-entity ${!checkedEntities.has(idx) ? "evolve-card-unchecked" : ""}`}>
                        <label className="evolve-card-check">
                          <input
                            type="checkbox"
                            checked={checkedEntities.has(idx)}
                            onChange={() => toggleEntity(idx)}
                            disabled={phase === "streaming"}
                          />
                        </label>
                        <div className="evolve-card-content">
                          <div className="evolve-card-name">
                            <span className="evolve-card-dot" style={{ background: getCategoryColor(ent.category) }} />
                            {ent.name}
                          </div>
                          <div className="evolve-card-category">{ent.category}</div>
                          {ent.summary && <div className="evolve-card-summary">{ent.summary}</div>}
                          {ent.tags?.length > 0 && (
                            <div className="evolve-card-tags">
                              {ent.tags.map(t => <span key={t} className="tag-pill tag-pill--small">{t}</span>)}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  if (item.type === "relationship") {
                    const rel = item.data;
                    const idx = item.idx;
                    return (
                      <div key={`r-${idx}`} className={`evolve-card evolve-card-rel ${!checkedRels.has(idx) ? "evolve-card-unchecked" : ""}`}>
                        <label className="evolve-card-check">
                          <input
                            type="checkbox"
                            checked={checkedRels.has(idx)}
                            onChange={() => toggleRel(idx)}
                            disabled={phase === "streaming"}
                          />
                        </label>
                        <div className="evolve-card-content">
                          <div className="evolve-card-name">
                            {rel.source} <span style={{ color: "var(--accent-cyan)", fontSize: 11 }}>—{rel.label}→</span> {rel.target}
                          </div>
                          {rel.fact && <div className="evolve-card-summary">{rel.fact}</div>}
                        </div>
                      </div>
                    );
                  }
                  if (item.type === "round") {
                    return (
                      <div key={`round-${fi}`} style={{ textAlign: "center", padding: "8px 0", color: "#4a9eff", fontSize: 12, fontWeight: 600, borderTop: "1px solid rgba(74,158,255,0.2)", marginTop: 8 }}>
                        — Round {item.data.round} —
                      </div>
                    );
                  }
                  if (item.type === "phase") {
                    return (
                      <div key={`phase-${fi}`} style={{ padding: "4px 0", color: "var(--text-secondary)", fontSize: 11, fontStyle: "italic" }}>
                        {item.data.message}
                      </div>
                    );
                  }
                  return null;
                })}

                {phase === "streaming" && entities.length === 0 && !error && (
                  <div className="evolve-streaming-indicator">
                    <div className="loading-spinner" style={{ width: 16, height: 16 }} />
                    <span>Researching...</span>
                  </div>
                )}
              </>
            )}

            {error && (
              <div className="evolve-error">
                {error}
                <button onClick={handleEvolve} className="evolve-retry-btn">Retry</button>
              </div>
            )}

            {saveResult && (
              <div className="evolve-save-result">
                Created {saveResult.entitiesCreated} entities, {saveResult.relationshipsCreated} relationships
                {saveResult.entitiesSkipped > 0 && ` (${saveResult.entitiesSkipped} skipped)`}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="evolve-modal-footer">
          <div className="evolve-footer-stats">
            {tokenInfo && <span>Tokens: {tokenInfo.totalTokens.toLocaleString()}</span>}
            <span>Entities: {entities.length}</span>
            <span>Rels: {relationships.length}</span>
          </div>

          <div className="evolve-footer-actions">
            {phase === "review" && entities.length + relationships.length > 0 && !saveResult && (
              <>
                {currentRound < 3 && (
                  <button
                    onClick={() => {
                      // Don't clear entities/rels — they accumulate across rounds
                      setPhase("streaming");
                      setError(null);
                      // Re-run the evolve with previous discoveries context
                      handleNextRound();
                    }}
                    style={{ fontSize: 12, padding: "6px 14px", background: "#4a9eff22", color: "#4a9eff", border: "1px solid #4a9eff44", borderRadius: 6, cursor: "pointer" }}
                  >
                    Run Round {currentRound + 1}
                  </button>
                )}
                <button
                  className="evolve-save-all-btn"
                  onClick={() => handleSave(true)}
                  disabled={saving}
                >
                  {saving ? "Saving..." : `Save All (${totalItems})`}
                </button>
                {!allChecked && (
                  <button
                    className="evolve-save-selected-btn"
                    onClick={() => handleSave(false)}
                    disabled={saving || totalChecked === 0}
                  >
                    Save Selected ({totalChecked}/{totalItems})
                  </button>
                )}
                <button className="evolve-cancel-btn" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
              </>
            )}
            {phase === "review" && entities.length + relationships.length === 0 && !error && (
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                No entities or relationships discovered.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
