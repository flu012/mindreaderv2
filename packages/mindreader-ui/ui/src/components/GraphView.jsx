import { forwardRef, useRef, useEffect, useCallback, useState } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import EdgeCurveProgram from "@sigma/edge-curve";
import { CATEGORY_COLORS } from "../constants";

// Base sizes (before degree scaling)
const GROUP_SIZES = {
  project: 7,
  person: 5,
  infrastructure: 5.5,
  agent: 4.5,
  other: 3.5,
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
  { data, colors, onNodeClick, selectedNode, onNodeHover, searchQuery: externalSearchQuery, onSearchSelect },
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
    //          zoom out → dots grow (so they stay visible)
    const ratio = cameraRatioRef.current;
    const zoomScale = Math.max(0.3, Math.min(3, Math.sqrt(ratio)));

    sigma.setSetting("nodeReducer", (node, attrs) => {
      const baseSize = (attrs.origSize || attrs.size || 7) * zoomScale;
      if (!activeNode) return { ...attrs, size: baseSize };
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
        res.color = dim(attrs.origColor || attrs.color || "#6688aa", 0.35);
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
  }, [getNodeContext]);

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

      graph.addNode(node.id, {
        label: node.name || "unknown",
        x, y,
        size,
        color,
        origColor: color,
        origSize: size,
        category: node.category,
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
    // Bigger variation: 0 connections = base, 5 = ~2.5x, 15 = ~4x, 30 = ~5.5x
    graph.forEachNode((node, attrs) => {
      const degree = graph.degree(node);
      const dynamicSize = attrs.origSize * (1 + Math.sqrt(degree) * 0.8);
      graph.setNodeAttribute(node, "size", dynamicSize);
      graph.setNodeAttribute(node, "origSize", dynamicSize);
    });

    runLayout(graph);
    sigma.refresh();
    sigma.getCamera().animatedReset({ duration: 500 });
  }, [data, colors]);

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
  const repulsionBase = Math.max(2400, n * 18); // More nodes = more repulsion (+20%)
  const springStrength = 0.0016; // Weaker springs = more spread (+20%)
  const gravity = 0.0024; // Lighter gravity = less center pull (+20%)

  for (let iter = 0; iter < 200; iter++) {
    // Repulsion: all nodes push each other apart
    // Hub nodes (high degree) push harder to create space
    for (let i = 0; i < nodeKeys.length; i++) {
      for (let j = i + 1; j < nodeKeys.length; j++) {
        const ki = nodeKeys[i], kj = nodeKeys[j];
        const a = nodes[ki], b = nodes[kj];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        // Hub nodes repel more: scale by sum of degrees
        const degreeScale = 1 + (degrees[ki] + degrees[kj]) * 0.15;
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
      // Ideal distance scales with combined degree (hubs should be further apart)
      const idealDist = 30 + (degrees[source] + degrees[target]) * 3;
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

export default GraphView;
