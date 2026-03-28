import { forwardRef, useRef, useEffect, useCallback, useState } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import EdgeCurveProgram from "@sigma/edge-curve";
import { CATEGORY_COLORS } from "../constants";

// Base sizes (before degree scaling)
const GROUP_SIZES = {
  project: 6,
  person: 4.5,
  infrastructure: 5,
  agent: 4,
  other: 3.25,
};

function lighten(hex, amount = 0.3) {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * amount));
  const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * amount));
  const b = Math.min(255, (num & 0xff) + Math.round(255 * amount));
  return `rgb(${r},${g},${b})`;
}

function dim(hex, alpha = 0.4) {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

const GraphView = forwardRef(function GraphView(
  { data, colors, onNodeClick, selectedNode, onNodeHover, searchQuery: externalSearchQuery, onSearchSelect, layout = "force", showDecay = false },
  ref
) {
  const containerRef = useRef(null);
  const sigmaRef = useRef(null);
  const graphRef = useRef(null);
  const highlightStateRef = useRef({
    hoveredNode: null,
    selectedNode: null,
    neighbors: new Set(),
    edges: new Set(),
  });
  const cameraRatioRef = useRef(1);

  const [searchResults, setSearchResults] = useState([]);

  const getNodeContext = useCallback((graph, nodeId) => {
    const neighbors = new Set();
    const edges = new Set();
    if (!graph || !nodeId || !graph.hasNode(nodeId)) return { neighbors, edges };
    graph.forEachEdge(nodeId, (edge, attrs, source, target) => {
      edges.add(edge);
      neighbors.add(source === nodeId ? target : source);
    });
    return { neighbors, edges };
  }, []);

  // Apply visual highlight state to the graph
  const applyHighlight = useCallback(() => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma) return;

    const s = highlightStateRef.current;
    const activeNode = s.hoveredNode || s.selectedNode;

    // Compute neighbors and edges for the active node
    let neighbors = new Set();
    let edges = new Set();
    if (activeNode) {
      const ctx = getNodeContext(graph, activeNode);
      neighbors = ctx.neighbors;
      edges = ctx.edges;
    }

    // Camera ratio: Sigma's ratio = high when zoomed out, low when zoomed in
    // We want: zoom in → dots shrink (so they don't cover others)
    //          zoom out → dots grow slightly (so they stay visible but not huge)
    const ratio = cameraRatioRef.current;
    const zoomScale = Math.max(0.25, Math.min(1.5, Math.pow(ratio, 0.35)));

    sigma.setSetting("nodeReducer", (node, attrs) => {
      const baseSize = (attrs.origSize || attrs.size || 7) * zoomScale;
      if (!activeNode) {
        const s = attrs.strength ?? 1.0;
        if (showDecay) {
          // Decay mode: color by strength gradient (green → yellow → red)
          const r = Math.round(s < 0.5 ? 255 : 255 * (1 - s) * 2);
          const g = Math.round(s > 0.5 ? 255 : 255 * s * 2);
          const strengthColor = `rgb(${r},${g},80)`;
          return { ...attrs, size: baseSize, color: strengthColor };
        }
        const alpha = 0.3 + s * 0.7; // strength 1.0 → alpha 1.0, strength 0.0 → alpha 0.3
        return { ...attrs, size: baseSize, color: dim(attrs.origColor || attrs.color || "#6688aa", alpha) };
      }
      const res = { ...attrs };
      if (node === activeNode) {
        res.color = lighten(attrs.origColor || attrs.color || "#6688aa", 0.35);
        res.size = baseSize * 1.5;
        res.zIndex = 10;
        res.highlighted = true;
      } else if (neighbors.has(node)) {
        res.color = lighten(attrs.origColor || attrs.color || "#6688aa", 0.15);
        res.size = baseSize * 1.15;
        res.zIndex = 5;
        res.highlighted = true;
      } else {
        const s = attrs.strength ?? 1.0;
        res.color = dim(attrs.origColor || attrs.color || "#6688aa", 0.15 + s * 0.2);
        res.size = baseSize * 0.85;
        res.zIndex = 0;
      }
      return res;
    });

    sigma.setSetting("edgeReducer", (edge, attrs) => {
      if (!activeNode) return { ...attrs, color: "rgba(74, 100, 160, 0.2)", size: 1 };
      const res = { ...attrs };
      if (edges.has(edge)) {
        res.color = "#4a9eff";
        res.size = 2.5;
        res.zIndex = 10;
      } else {
        res.color = "rgba(30, 30, 60, 0.06)";
        res.size = 0.3;
      }
      return res;
    });

    sigma.refresh();
  }, [getNodeContext, showDecay]);

  // Initialize Sigma
  useEffect(() => {
    if (!containerRef.current) return;

    const graph = new Graph();
    graphRef.current = graph;

    const sigma = new Sigma(graph, containerRef.current, {
      defaultNodeColor: "#6688aa",
      defaultEdgeColor: "rgba(74, 100, 160, 0.2)",
      defaultEdgeType: "curve",
      edgeProgramClasses: { curve: EdgeCurveProgram },
      labelColor: { color: "#c0c0d8" },
      labelFont: "Inter, -apple-system, sans-serif",
      labelSize: 13,
      labelWeight: "bold",
      labelRenderedSizeThreshold: 5,
      stagePadding: 40,
      zIndex: true,
      allowInvalidContainer: true,
      renderLabels: true,
      renderEdgeLabels: false,
      enableEdgeEvents: false,
    });

    sigmaRef.current = sigma;

    // Click handler
    sigma.on("clickNode", ({ node }) => {
      const nodeAttrs = graph.getNodeAttributes(node);
      highlightStateRef.current.selectedNode = node;
      applyHighlight();
      if (onNodeClick) {
        onNodeClick({ name: nodeAttrs.label, id: node, category: nodeAttrs.category });
      }
    });

    // Hover
    sigma.on("enterNode", ({ node }) => {
      const nodeAttrs = graph.getNodeAttributes(node);
      highlightStateRef.current.hoveredNode = node;
      applyHighlight();
      if (onNodeHover) {
        onNodeHover({ name: nodeAttrs.label, id: node, category: nodeAttrs.category });
      }
      containerRef.current.style.cursor = "pointer";
    });

    sigma.on("leaveNode", () => {
      highlightStateRef.current.hoveredNode = null;
      applyHighlight();
      if (onNodeHover) onNodeHover(null);
      containerRef.current.style.cursor = "grab";
    });

    // Click background
    sigma.on("clickStage", () => {
      highlightStateRef.current.selectedNode = null;
      applyHighlight();
    });

    // Track camera zoom and update node sizes dynamically
    const camera = sigma.getCamera();
    const handleCameraUpdate = () => {
      const newRatio = camera.getState().ratio;
      if (Math.abs(newRatio - cameraRatioRef.current) > 0.05) {
        cameraRatioRef.current = newRatio;
        applyHighlight(); // re-apply with new zoom scale
      }
    };
    camera.on("updated", handleCameraUpdate);

    return () => {
      camera.off("updated", handleCameraUpdate);
      sigma.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [applyHighlight, onNodeClick, onNodeHover]);

  // Sync selectedNode from parent
  useEffect(() => {
    if (!selectedNode) {
      highlightStateRef.current.selectedNode = null;
      applyHighlight();
    }
  }, [selectedNode, applyHighlight]);

  // Re-apply highlight when showDecay changes
  useEffect(() => {
    applyHighlight();
  }, [showDecay, applyHighlight]);

  // Search filter
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !externalSearchQuery?.trim()) { setSearchResults([]); return; }
    const q = externalSearchQuery.toLowerCase();
    const results = [];
    graph.forEachNode((node, attrs) => {
      if (attrs.label && attrs.label.toLowerCase().includes(q)) {
        results.push({ id: node, label: attrs.label, category: attrs.category, color: attrs.origColor || attrs.color });
      }
    });
    setSearchResults(results.slice(0, 10));
  }, [externalSearchQuery]);

  // Select from search
  const handleSearchSelect = useCallback((nodeId) => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma || !graph.hasNode(nodeId)) return;

    const nodeAttrs = graph.getNodeAttributes(nodeId);
    highlightStateRef.current.selectedNode = nodeId;
    applyHighlight();

    // Animate camera
    const nodePosition = sigma.getNodeDisplayData(nodeId);
    if (nodePosition) {
      sigma.getCamera().animate({ x: nodePosition.x, y: nodePosition.y, ratio: 0.3 }, { duration: 500 });
    }

    if (onNodeClick) {
      onNodeClick({ name: nodeAttrs.label, id: nodeId, category: nodeAttrs.category });
    }

    // Clear global search via parent callback
    if (onSearchSelect) onSearchSelect();
  }, [applyHighlight, onNodeClick, onSearchSelect]);

  // Update graph data
  useEffect(() => {
    const graph = graphRef.current;
    const sigma = sigmaRef.current;
    if (!graph || !sigma || !data) return;

    graph.clear();
    highlightStateRef.current = {
      hoveredNode: null, selectedNode: null,
      neighbors: new Set(), edges: new Set(),
    };

    const nodeCount = data.nodes.length;
    data.nodes.forEach((node, i) => {
      const angle = (i / nodeCount) * Math.PI * 2 * 3;
      const radius = 50 + (i / nodeCount) * 250;
      const x = node.x != null ? node.x : Math.cos(angle) * radius;
      const y = node.y != null ? node.y : Math.sin(angle) * radius;
      const color = (colors || CATEGORY_COLORS)[node.category] || CATEGORY_COLORS.other;
      const size = GROUP_SIZES[node.category] || GROUP_SIZES.other;

      const isExpired = !!node.expired_at;
      const strength = isExpired ? 0 : (node.strength ?? 1.0);

      graph.addNode(node.id, {
        label: node.name || "unknown",
        x, y,
        size: isExpired ? size * 0.7 : size,
        color: isExpired ? "rgba(100,100,120,0.25)" : color,
        origColor: isExpired ? "#666678" : color,
        origSize: isExpired ? size * 0.7 : size,
        category: node.category,
        strength,
        expired: isExpired,
      });
    });

    const addedEdges = new Set();
    data.links.forEach((link) => {
      const sourceId = typeof link.source === "object" ? link.source.id : link.source;
      const targetId = typeof link.target === "object" ? link.target.id : link.target;
      if (!sourceId || !targetId) return;
      if (!graph.hasNode(sourceId) || !graph.hasNode(targetId)) return;
      const edgeKey = `${sourceId}->${targetId}`;
      if (addedEdges.has(edgeKey)) return;
      addedEdges.add(edgeKey);
      try {
        graph.addEdge(sourceId, targetId, {
          label: link.label || "",
          color: "rgba(74, 100, 160, 0.2)",
          size: 1,
          type: "curve",
          curvature: 0.25,
        });
      } catch (e) { /* skip */ }
    });

    // Dynamic sizing: scale node size by degree (number of connections)
    // Gentler scaling: 0 connections = base, 5 = ~1.9x, 15 = ~2.6x, 30 = ~3.2x
    graph.forEachNode((node, attrs) => {
      const degree = graph.degree(node);
      const dynamicSize = attrs.origSize * (1 + Math.sqrt(degree) * 0.4);
      graph.setNodeAttribute(node, "size", dynamicSize);
      graph.setNodeAttribute(node, "origSize", dynamicSize);
    });

    applyLayout(graph, layout);
    sigma.refresh();
    sigma.getCamera().animatedReset({ duration: 500 });
  }, [data, colors, layout]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          background: "linear-gradient(135deg, #0a0a1a 0%, #0d1025 50%, #0a0a1a 100%)",
          cursor: "grab",
        }}
      />
      {/* Search results dropdown (driven by global search bar) */}
      {searchResults.length > 0 && (
        <div style={{
          position: "absolute", top: 12, left: "50%",
          transform: "translateX(-50%)", zIndex: 100, width: 320,
        }}>
          <div style={{
            background: "rgba(15, 15, 35, 0.85)",
            backdropFilter: "blur(16px)",
            border: "1px solid rgba(74, 158, 255, 0.2)",
            borderRadius: 10,
            boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
            maxHeight: 280, overflowY: "auto",
          }}>
            {searchResults.map((r) => {
              // Look up tags from original data
              const nodeData = data?.nodes?.find(n => n.id === r.id);
              const tags = nodeData?.tags || [];
              return (
                <div
                  key={r.id}
                  onMouseDown={(e) => { e.preventDefault(); handleSearchSelect(r.id); }}
                  style={{
                    padding: "8px 12px", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 8,
                    fontSize: 13, color: "#d0d0e8",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "rgba(74, 158, 255, 0.1)"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.color || "#6688aa", flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>
                    {r.label}
                    {tags.length > 0 && (
                      <span className="tag-pills" style={{ display: "inline-flex", marginLeft: 6, gap: 3 }}>
                        {tags.slice(0, 3).map(t => (
                          <span key={t} className="tag-pill tag-pill--small">{t}</span>
                        ))}
                        {tags.length > 3 && <span style={{ fontSize: 10, color: "#8888aa" }}>+{tags.length - 3}</span>}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 10, color: "#8888aa", textTransform: "uppercase", letterSpacing: 1 }}>{r.category}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

function runLayout(graph) {
  const nodes = {};
  const degrees = {};
  graph.forEachNode((node, attrs) => {
    nodes[node] = { x: attrs.x, y: attrs.y, vx: 0, vy: 0 };
    degrees[node] = graph.degree(node);
  });
  const edges = [];
  graph.forEachEdge((edge, attrs, source, target) => { edges.push({ source, target }); });
  const nodeKeys = Object.keys(nodes);

  // Scale layout params based on graph size
  const n = nodeKeys.length;
  const repulsionBase = Math.max(1600, n * 12); // Moderate repulsion
  const springStrength = 0.002; // Slightly stronger springs = tighter clusters
  const gravity = 0.006; // Stronger gravity pulls outliers back toward center

  for (let iter = 0; iter < 200; iter++) {
    // Repulsion: all nodes push each other apart
    // Hub nodes (high degree) push harder to create space
    for (let i = 0; i < nodeKeys.length; i++) {
      for (let j = i + 1; j < nodeKeys.length; j++) {
        const ki = nodeKeys[i], kj = nodeKeys[j];
        const a = nodes[ki], b = nodes[kj];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        // Hub nodes repel more: scale by sum of degrees (gentler)
        const degreeScale = 1 + (degrees[ki] + degrees[kj]) * 0.08;
        const force = (repulsionBase * degreeScale) / (dist * dist);
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }

    // Spring attraction: connected nodes pull toward each other
    for (const { source, target } of edges) {
      const a = nodes[source], b = nodes[target];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      // Ideal distance scales with combined degree (hubs should be further apart, but capped)
      const idealDist = 25 + Math.min((degrees[source] + degrees[target]) * 2, 60);
      const force = (dist - idealDist) * springStrength;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }

    // Gentle gravity + damping
    const damping = iter < 50 ? 0.88 : 0.85; // Less damping early for bigger moves
    for (const key of nodeKeys) {
      const n = nodes[key];
      n.vx -= n.x * gravity; n.vy -= n.y * gravity;
      n.vx *= damping; n.vy *= damping;
      n.x += n.vx; n.y += n.vy;
    }
  }

  for (const key of nodeKeys) {
    graph.setNodeAttribute(key, "x", nodes[key].x);
    graph.setNodeAttribute(key, "y", nodes[key].y);
  }
}

// --- ForceAtlas2 layout ---
let forceAtlas2Module = null;
import("graphology-layout-forceatlas2").then(mod => {
  forceAtlas2Module = mod.default || mod;
}).catch(() => {});

function runForceAtlas2(graph) {
  if (!forceAtlas2Module) { runLayout(graph); return; }
  forceAtlas2Module.assign(graph, {
    iterations: 200,
    settings: { gravity: 1, scalingRatio: 2, strongGravityMode: false, barnesHutOptimize: graph.order > 200 },
  });
}

// --- Radial layout: BFS layers from most-connected node ---
function runRadialLayout(graph) {
  const nodeKeys = [];
  graph.forEachNode(n => nodeKeys.push(n));
  if (nodeKeys.length === 0) return;

  // Find center: highest degree node
  let center = nodeKeys[0], maxDeg = 0;
  for (const n of nodeKeys) {
    const d = graph.degree(n);
    if (d > maxDeg) { maxDeg = d; center = n; }
  }

  // BFS to assign layers
  const layers = {};
  layers[center] = 0;
  const queue = [center];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    graph.forEachNeighbor(cur, (neighbor) => {
      if (layers[neighbor] === undefined) {
        layers[neighbor] = layers[cur] + 1;
        queue.push(neighbor);
      }
    });
  }

  // Assign disconnected nodes to outermost layer + 1
  const maxLayer = Math.max(0, ...Object.values(layers));
  for (const n of nodeKeys) {
    if (layers[n] === undefined) layers[n] = maxLayer + 1;
  }

  // Group by layer
  const byLayer = {};
  for (const n of nodeKeys) {
    const l = layers[n];
    if (!byLayer[l]) byLayer[l] = [];
    byLayer[l].push(n);
  }

  const layerRadius = 100;
  for (const [layer, nodes] of Object.entries(byLayer)) {
    const l = Number(layer);
    const r = l * layerRadius;
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      graph.setNodeAttribute(n, "x", r === 0 ? 0 : Math.cos(angle) * r);
      graph.setNodeAttribute(n, "y", r === 0 ? 0 : Math.sin(angle) * r);
    });
  }
}

// --- Circular layout: nodes distributed by category in sectors ---
function runCircularLayout(graph) {
  const groups = {};
  graph.forEachNode((n, attrs) => {
    const cat = attrs.category || "other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(n);
  });

  const cats = Object.keys(groups);
  const sectorAngle = (Math.PI * 2) / (cats.length || 1);
  const radius = 250;

  cats.forEach((cat, ci) => {
    const nodes = groups[cat];
    const sectorStart = ci * sectorAngle;
    nodes.forEach((n, ni) => {
      const angle = sectorStart + (ni / nodes.length) * sectorAngle;
      graph.setNodeAttribute(n, "x", Math.cos(angle) * radius);
      graph.setNodeAttribute(n, "y", Math.sin(angle) * radius);
    });
  });
}

// --- Cluster layout: categories at polygon vertices, mini force within ---
function runClusterLayout(graph) {
  const groups = {};
  graph.forEachNode((n, attrs) => {
    const cat = attrs.category || "other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(n);
  });

  const cats = Object.keys(groups);
  const outerRadius = 300;

  // Assign each category a center on a regular polygon
  const centers = {};
  cats.forEach((cat, i) => {
    const angle = (i / cats.length) * Math.PI * 2 - Math.PI / 2;
    centers[cat] = { x: Math.cos(angle) * outerRadius, y: Math.sin(angle) * outerRadius };
  });

  // Place nodes in spiral around their category center, then mini force
  for (const cat of cats) {
    const nodes = groups[cat];
    const cx = centers[cat].x, cy = centers[cat].y;
    const pos = {};

    // Initial spiral placement
    nodes.forEach((n, i) => {
      const angle = i * 0.8;
      const r = 10 + i * 4;
      pos[n] = { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, vx: 0, vy: 0 };
    });

    // Mini force: 50 iterations, nodes repel each other, gravity to center
    for (let iter = 0; iter < 50; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = pos[nodes[i]], b = pos[nodes[j]];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 400 / (dist * dist);
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
      }
      for (const n of nodes) {
        const p = pos[n];
        p.vx -= (p.x - cx) * 0.01;
        p.vy -= (p.y - cy) * 0.01;
        p.vx *= 0.85; p.vy *= 0.85;
        p.x += p.vx; p.y += p.vy;
      }
    }

    for (const n of nodes) {
      graph.setNodeAttribute(n, "x", pos[n].x);
      graph.setNodeAttribute(n, "y", pos[n].y);
    }
  }
}

// --- Grid layout: nodes in grids grouped by category ---
function runGridLayout(graph) {
  const groups = {};
  graph.forEachNode((n, attrs) => {
    const cat = attrs.category || "other";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(n);
  });

  const cats = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  const cellSize = 35;
  const groupGap = 120;
  let offsetX = 0;

  for (const cat of cats) {
    const nodes = groups[cat];
    const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    nodes.forEach((n, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      graph.setNodeAttribute(n, "x", offsetX + col * cellSize);
      graph.setNodeAttribute(n, "y", row * cellSize);
    });
    const rows = Math.ceil(nodes.length / cols);
    offsetX += cols * cellSize + groupGap;
  }

  // Center the whole grid
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  graph.forEachNode((n, attrs) => {
    if (attrs.x < minX) minX = attrs.x;
    if (attrs.x > maxX) maxX = attrs.x;
    if (attrs.y < minY) minY = attrs.y;
    if (attrs.y > maxY) maxY = attrs.y;
  });
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  graph.forEachNode((n, attrs) => {
    graph.setNodeAttribute(n, "x", attrs.x - cx);
    graph.setNodeAttribute(n, "y", attrs.y - cy);
  });
}

// --- Layout dispatcher ---
function applyLayout(graph, layout) {
  switch (layout) {
    case "forceatlas2": runForceAtlas2(graph); break;
    case "radial": runRadialLayout(graph); break;
    case "circular": runCircularLayout(graph); break;
    case "cluster": runClusterLayout(graph); break;
    case "grid": runGridLayout(graph); break;
    default: runLayout(graph); break;
  }
}

export default GraphView;
