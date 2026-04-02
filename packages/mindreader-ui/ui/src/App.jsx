import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import GraphView from "./components/GraphView";
import DetailPanel from "./components/DetailPanel";
import HoverTooltip from "./components/HoverTooltip";
import ListView from "./components/ListView";
import TimelineView from "./components/TimelineView";
import CategoryView from "./components/CategoryView";
import MaintenanceView from "./components/MaintenanceView";
import ActivityLog from "./components/ActivityLog";
import TokenDashboard from "./components/TokenDashboard";
import LoginPage from "./components/LoginPage";
import { CATEGORY_COLORS, CATEGORY_LABELS } from "./constants";

const TABS = [
  { id: "list", label: "List", icon: "\u{1F4CB}" },
  { id: "timeline", label: "Timeline", icon: "\u{1F554}" },
  { id: "graph", label: "Graph", icon: "\u{1F517}" },
  { id: "categories", label: "Categories", icon: "\u{1F3F7}\uFE0F" },
  { id: "activity", label: "Activity", icon: "\u{1F4CA}" },
  { id: "tokens", label: "Tokens", icon: "\u{1F4B0}" },
  { id: "maintenance", label: "Maintenance", icon: "\u{1F527}" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState(() => {
    const hash = window.location.hash.replace("#", "");
    const valid = TABS.map(t => t.id);
    return valid.includes(hash) ? hash : "list";
  });
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState(null);
  const [entityDetail, setEntityDetail] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [hoveredNode, setHoveredNode] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [hiddenTypes, setHiddenTypes] = useState(new Set());
  const [graphLayout, setGraphLayout] = useState("force");
  const [showDecay, setShowDecay] = useState(false);
  const [timeSliderDate, setTimeSliderDate] = useState(null); // null = "now" (no filter)
  const [timeSliderEnabled, setTimeSliderEnabled] = useState(false);
  const [timeAutoPlaying, setTimeAutoPlaying] = useState(false);
  const timeAutoPlayRef = useRef(null);
  const [egoGraph, setEgoGraph] = useState(null); // { data, center } when viewing ego subgraph
  const [refreshKey, setRefreshKey] = useState(0);
  const [dynamicCategories, setDynamicCategories] = useState(null);
  const [authUser, setAuthUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);
  const graphRef = useRef();
  const searchInputRef = useRef();

  // Sync tab with URL hash
  const changeTab = useCallback((id) => {
    setActiveTab(id);
    if (id !== "graph") setEgoGraph(null);
    window.location.hash = id;
  }, []);

  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash.replace("#", "");
      const valid = TABS.map(t => t.id);
      if (valid.includes(hash)) setActiveTab(hash);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Check auth status on mount
  useEffect(() => {
    fetch("/api/auth/status")
      .then(r => r.json())
      .then(data => {
        if (data.authenticated) setAuthUser(data);
        else if (!data.authEnabled) setAuthUser({ email: "local", tenantId: "master" });
        setAuthChecking(false);
      })
      .catch(() => {
        // Auth endpoint doesn't exist (old version) — skip auth
        setAuthUser({ email: "local", tenantId: "master" });
        setAuthChecking(false);
      });
  }, []);

  // Load categories from API
  useEffect(() => {
    fetch("/api/categories")
      .then(r => r.json())
      .then(cats => { if (Array.isArray(cats)) setDynamicCategories(cats); })
      .catch(() => {});
  }, [refreshKey]);

  // Build category colors/labels from API data (fallback to constants)
  const catColors = useMemo(() => {
    if (!dynamicCategories) return CATEGORY_COLORS;
    const c = {};
    dynamicCategories.forEach(cat => { c[cat.key] = cat.color || "#888"; });
    return c;
  }, [dynamicCategories]);

  const catLabels = useMemo(() => {
    if (!dynamicCategories) return CATEGORY_LABELS;
    const l = {};
    dynamicCategories.forEach(cat => { l[cat.key] = cat.label || cat.key; });
    return l;
  }, [dynamicCategories]);

  // Load graph data (for graph tab), re-fetch on refreshKey change — only when graph tab is active
  useEffect(() => {
    if (activeTab !== "graph") return;
    setLoading(true);
    // Graph view: 500 nodes is enough for visualization
    // Server prioritizes non-"other" categories
    const graphUrl = `/api/graph?limit=500${showDecay ? "&showExpired=true" : ""}`;
    fetch(graphUrl)
      .then((r) => r.json())
      .then((graph) => { setGraphData(graph); setLoading(false); })
      .catch((err) => { console.error("Failed to load graph:", err); setLoading(false); });
  }, [refreshKey, activeTab, showDecay]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleSelectEntity = useCallback(async (name) => {
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(name)}`);
      if (res.ok) {
        const data = await res.json();
        setEntityDetail(data);
        setSelectedNode({ name });
      }
    } catch (err) {
      console.error("Failed to load entity:", err);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setEntityDetail(null);
    setSelectedNode(null);
  }, []);

  // Graph-specific handlers
  const handleNodeClick = useCallback(async (node) => {
    setSelectedNode(node);
    try {
      // Use uuid if available for precise lookup (handles duplicate names)
      const identifier = node.id || node.name;
      const res = await fetch(`/api/entity/${encodeURIComponent(identifier)}`);
      if (res.ok) setEntityDetail(await res.json());
    } catch (err) {
      console.error("Failed to load entity:", err);
    }
  }, []);

  const nodeMap = useMemo(
    () => new Map(graphData.nodes.map(n => [n.id, n])),
    [graphData.nodes]
  );

  const handleNodeHover = useCallback((node) => {
    if (!node) { setHoveredNode(null); return; }
    const full = nodeMap.get(node.id);
    setHoveredNode({ ...node, tags: full?.tags || [], summary: full?.summary });
  }, [nodeMap]);
  const handleMouseMove = useCallback((e) => setTooltipPos({ x: e.clientX, y: e.clientY }), []);

  const handleViewGraph = useCallback(async (entityName) => {
    try {
      const res = await fetch(`/api/graph/ego/${encodeURIComponent(entityName)}?depth=2`);
      if (!res.ok) return;
      const data = await res.json();
      setEgoGraph({ data, center: entityName });
      changeTab("graph");
    } catch (err) {
      console.error("Failed to load ego graph:", err);
    }
  }, [changeTab]);

  const clearEgoGraph = useCallback(() => setEgoGraph(null), []);

  const toggleFilter = useCallback((group) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      next.has(group) ? next.delete(group) : next.add(group);
      return next;
    });
  }, []);

  const filteredData = useMemo(() => {
    const source = egoGraph ? egoGraph.data : graphData;
    if (hiddenTypes.size === 0) return source;
    const nodes = source.nodes.filter((n) => !hiddenTypes.has(n.category));
    const ids = new Set(nodes.map((n) => n.id));
    const links = source.links.filter((l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return ids.has(s) && ids.has(t);
    });
    return { nodes, links };
  }, [graphData, hiddenTypes, egoGraph]);

  // Date range for time slider (min created_at to now)
  const graphDateRange = useMemo(() => {
    const source = filteredData || graphData;
    if (!source?.nodes?.length) return null;
    const dates = source.nodes
      .map(n => n.created_at ? new Date(n.created_at).getTime() : null)
      .filter(Boolean);
    if (!dates.length) return null;
    return { min: dates.reduce((a, b) => a < b ? a : b), max: Date.now() };
  }, [filteredData, graphData]);

  // Filter graph data by the time slider date
  const filteredByTimeData = useMemo(() => {
    if (!timeSliderEnabled || !timeSliderDate || !filteredData) return filteredData;
    const asOf = timeSliderDate;
    const nodes = filteredData.nodes.filter(n => {
      const created = n.created_at ? new Date(n.created_at).getTime() : null;
      if (created === null) return true; // no timestamp — always show
      if (created > asOf) return false; // didn't exist yet
      return true; // show both alive and expired (GraphView handles visual distinction)
    });
    const nodeIds = new Set(nodes.map(n => n.id));
    const links = filteredData.links.filter(l => {
      const src = typeof l.source === 'object' ? l.source.id : l.source;
      const tgt = typeof l.target === 'object' ? l.target.id : l.target;
      if (!nodeIds.has(src) || !nodeIds.has(tgt)) return false;
      const created = l.created_at ? new Date(l.created_at).getTime() : null;
      if (created === null) return true;
      if (created > asOf) return false;
      const expiredAt = l.expired_at ? new Date(l.expired_at).getTime() : null;
      if (expiredAt && expiredAt <= asOf) return false;
      return true;
    });
    // Mark nodes as ghost if they were expired by this date
    const nodesWithGhostState = nodes.map(n => {
      const expiredAt = n.expired_at ? new Date(n.expired_at).getTime() : null;
      const isGhostAtDate = expiredAt && expiredAt <= asOf;
      return isGhostAtDate ? { ...n, expired_at: n.expired_at, strength: 0 } : n;
    });
    return { nodes: nodesWithGhostState, links };
  }, [filteredData, timeSliderEnabled, timeSliderDate]);

  const navigateToEntity = useCallback(
    (name) => {
      // For graph tab, just select the entity (Sigma handles camera internally)
      handleSelectEntity(name);
    },
    [handleSelectEntity]
  );

  const handleSearchInput = useCallback((e) => {
    setSearchQuery(e.target.value);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
      if (e.key === "Escape") {
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const [categoryCounts, setCategoryCounts] = useState({});

  // Fetch category counts from /api/stats for accurate totals
  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data) => {
        if (data.entityGroups) {
          setCategoryCounts(data.entityGroups);
        }
      })
      .catch((err) => console.error("Failed to load stats:", err));
  }, []);

  if (authChecking) return <div style={{ minHeight: "100vh", background: "#0a0a14" }} />;
  if (!authUser) return <LoginPage onLogin={(user) => setAuthUser(user)} />;

  if (loading && activeTab === "graph") {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        <div>Loading Knowledge Graph...</div>
      </div>
    );
  }

  return (
    <div className="app" onMouseMove={handleMouseMove}>
      <div className="main-container">
        {/* Top Bar */}
        <div className="top-bar-fixed">
          <div className="top-bar-left">
            <div className="logo">
              <span className="logo-icon">{"\u{1F9E0}"}</span>
              <span>MindReader</span>
            </div>
            <div className="tab-bar">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`tab-btn ${activeTab === tab.id ? "active" : ""}`}
                  onClick={() => changeTab(tab.id)}
                >
                  <span className="tab-icon">{tab.icon}</span>
                  <span className="tab-label">{tab.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="top-bar-right">
            <div className="search-box">
              <span className="search-icon">{"\u{1F50D}"}</span>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search memories... (Ctrl+K)"
                value={searchQuery}
                onChange={handleSearchInput}
              />
              {searchQuery && (
                <button className="search-clear" onClick={() => setSearchQuery("")}>
                  {"\u2715"}
                </button>
              )}
            </div>
            <div className="stats-bar">
              <div className="stat-item"><span className="stat-value">{graphData.nodes.length}</span> nodes</div>
              <div className="stat-item"><span className="stat-value">{graphData.links.length}</span> edges</div>
              <button className="refresh-btn" onClick={handleRefresh} title="Refresh data">{"\uD83D\uDD04"}</button>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className={`content-area ${entityDetail ? "with-detail" : ""}`}>
          <div className="view-content">
            {activeTab === "list" && (
              <ListView searchQuery={searchQuery} onSelectEntity={handleSelectEntity} />
            )}

            {activeTab === "timeline" && (
              <TimelineView searchQuery={searchQuery} onSelectEntity={handleSelectEntity} refreshKey={refreshKey} />
            )}

            {activeTab === "graph" && (
              <div className="graph-wrapper">
                {/* Ego graph banner */}
                {egoGraph && (
                  <div style={{
                    position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 100,
                    background: "rgba(10, 10, 26, 0.9)", backdropFilter: "blur(12px)",
                    border: "1px solid rgba(74, 158, 255, 0.25)", borderRadius: 10,
                    padding: "8px 16px", display: "flex", alignItems: "center", gap: 12,
                    boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
                  }}>
                    <span style={{ fontSize: 13, color: "#4a9eff" }}>
                      🕸️ Viewing <strong>{egoGraph.center}</strong> ({filteredData.nodes.length} nodes)
                    </span>
                    <button
                      onClick={clearEgoGraph}
                      style={{
                        padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                        cursor: "pointer", background: "rgba(74, 158, 255, 0.15)",
                        border: "1px solid rgba(74, 158, 255, 0.3)", color: "#4a9eff",
                      }}
                    >Back to full graph</button>
                  </div>
                )}
                {/* Layout selector */}
                <div style={{
                  position: "absolute", bottom: 16, right: 16, zIndex: 100,
                  background: "rgba(10, 10, 26, 0.85)", backdropFilter: "blur(12px)",
                  border: "1px solid rgba(74, 158, 255, 0.15)", borderRadius: 10,
                  padding: "8px 10px", display: "flex", flexDirection: "column", gap: 3,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.4)", minWidth: 110,
                }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 2 }}>
                    Layout
                  </span>
                  {[
                    { id: "force", label: "Force", icon: "\u{2B55}" },
                    { id: "forceatlas2", label: "Atlas", icon: "\u{1F30A}" },
                    { id: "radial", label: "Radial", icon: "\u{1F3AF}" },
                    { id: "circular", label: "Circular", icon: "\u{1F504}" },
                    { id: "cluster", label: "Cluster", icon: "\u{2B50}" },
                    { id: "grid", label: "Grid", icon: "\u{1F4CB}" },
                  ].map(l => (
                    <div
                      key={l.id}
                      onClick={() => setGraphLayout(l.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        padding: "4px 6px", borderRadius: 6, cursor: "pointer",
                        background: graphLayout === l.id ? "rgba(74, 158, 255, 0.15)" : "transparent",
                        color: graphLayout === l.id ? "#4a9eff" : "var(--text-primary)",
                        fontSize: 12, transition: "background 0.15s, color 0.15s",
                      }}
                    >
                      <span style={{ fontSize: 13, width: 18, textAlign: "center" }}>{l.icon}</span>
                      <span>{l.label}</span>
                    </div>
                  ))}
                </div>
                {/* Decay mode toggle + Time Travel toggle */}
                <div style={{
                  position: "absolute", top: 10, right: 10, zIndex: 20,
                  background: "rgba(20,20,30,0.85)", borderRadius: 8, padding: "6px 12px",
                  border: "1px solid rgba(255,255,255,0.08)",
                  display: "flex", flexDirection: "column", gap: 4,
                }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={showDecay}
                      onChange={(e) => setShowDecay(e.target.checked)}
                      style={{ accentColor: "#4aff9e" }}
                    />
                    Show Decay
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={timeSliderEnabled}
                      onChange={(e) => {
                        setTimeSliderEnabled(e.target.checked);
                        if (e.target.checked) setShowDecay(true);
                        if (!e.target.checked) {
                          setTimeSliderDate(null);
                          if (timeAutoPlayRef.current) { clearInterval(timeAutoPlayRef.current); timeAutoPlayRef.current = null; setTimeAutoPlaying(false); }
                        }
                      }}
                      style={{ accentColor: "#4a9eff" }}
                    />
                    Time Travel
                  </label>
                </div>
                {/* Categories filter */}
                <div style={{
                  position: "absolute", bottom: 16, left: 16, zIndex: 100,
                  background: "rgba(10, 10, 26, 0.85)", backdropFilter: "blur(12px)",
                  border: "1px solid rgba(74, 158, 255, 0.15)", borderRadius: 10,
                  padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.4)", minWidth: 130,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1 }}>
                      Categories
                    </span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => setHiddenTypes(new Set())} title="Show all" style={{
                        background: "none", border: "none", color: "var(--text-secondary)",
                        cursor: "pointer", fontSize: 10, padding: "1px 4px",
                      }}>All</button>
                      <span style={{ color: "rgba(255,255,255,0.15)", fontSize: 10 }}>|</span>
                      <button onClick={() => setHiddenTypes(new Set(Object.keys(catLabels)))} title="Hide all" style={{
                        background: "none", border: "none", color: "var(--text-secondary)",
                        cursor: "pointer", fontSize: 10, padding: "1px 4px",
                      }}>None</button>
                    </div>
                  </div>
                  {Object.entries(catLabels).map(([key, label]) => {
                    const isHidden = hiddenTypes.has(key);
                    const count = categoryCounts[key] || 0;
                    return (
                      <div
                        key={key}
                        onClick={() => toggleFilter(key)}
                        style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "4px 6px", borderRadius: 6, cursor: "pointer",
                          opacity: isHidden ? 0.35 : 1, transition: "opacity 0.2s",
                          fontSize: 12,
                        }}
                      >
                        <span style={{
                          width: 10, height: 10, borderRadius: "50%",
                          background: isHidden ? "transparent" : catColors[key],
                          border: `2px solid ${catColors[key]}`,
                          display: "inline-block", flexShrink: 0,
                        }} />
                        <span style={{ color: "var(--text-primary)", flex: 1 }}>{label}</span>
                        <span style={{ color: "var(--text-secondary)", fontSize: 10 }}>{count}</span>
                      </div>
                    );
                  })}
                </div>
                <GraphView
                  ref={graphRef}
                  data={filteredByTimeData}
                  colors={catColors}
                  onNodeClick={handleNodeClick}
                  onNodeHover={handleNodeHover}
                  selectedNode={selectedNode}
                  searchQuery={searchQuery}
                  onSearchSelect={() => setSearchQuery("")}
                  layout={graphLayout}
                  showDecay={showDecay}
                />
                {hoveredNode && !selectedNode && (
                  <HoverTooltip node={hoveredNode} position={tooltipPos} />
                )}
                {/* Time Slider */}
                {timeSliderEnabled && graphDateRange && (() => {
                  const range = graphDateRange.max - graphDateRange.min;
                  const tickCount = 5;
                  const ticks = Array.from({ length: tickCount }, (_, i) => {
                    const t = graphDateRange.min + (range * i) / (tickCount - 1);
                    const d = new Date(t);
                    return { pos: (i / (tickCount - 1)) * 100, label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) };
                  });

                  return (
                    <div style={{
                      position: "absolute", bottom: 20, left: "25%", right: "25%", zIndex: 20,
                      background: "rgba(20,20,30,0.92)", borderRadius: 10, padding: "10px 16px 6px",
                      border: "1px solid rgba(255,255,255,0.08)", backdropFilter: "blur(8px)",
                    }}>
                      {/* Current date display */}
                      <div style={{ textAlign: "center", fontSize: 13, fontWeight: 600, color: "#4aff9e", marginBottom: 6 }}>
                        {timeSliderDate
                          ? new Date(timeSliderDate).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) + " " + new Date(timeSliderDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                          : "Now"}
                      </div>
                      {/* Slider */}
                      <input
                        type="range"
                        min={graphDateRange.min}
                        max={graphDateRange.max}
                        value={timeSliderDate || graphDateRange.max}
                        onChange={(e) => setTimeSliderDate(Number(e.target.value))}
                        style={{ width: "100%", accentColor: "#4aff9e", margin: 0 }}
                      />
                      {/* Date gauge ticks */}
                      <div style={{ position: "relative", height: 16, marginTop: 2 }}>
                        {ticks.map((tick, i) => (
                          <span key={i} style={{
                            position: "absolute", left: `${tick.pos}%`, transform: "translateX(-50%)",
                            fontSize: 9, color: "var(--text-secondary)", whiteSpace: "nowrap",
                          }}>
                            {i === tickCount - 1 ? "Now" : tick.label}
                          </span>
                        ))}
                      </div>
                      {/* Controls */}
                      <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 4, paddingBottom: 2 }}>
                        <button
                          onClick={() => {
                            if (timeAutoPlayRef.current) {
                              clearInterval(timeAutoPlayRef.current);
                              timeAutoPlayRef.current = null;
                              setTimeAutoPlaying(false);
                            } else {
                              const start = graphDateRange.min;
                              const end = graphDateRange.max;
                              const totalMs = 30000;
                              const stepMs = 50;
                              const steps = totalMs / stepMs;
                              const increment = (end - start) / steps;
                              let current = start;
                              setTimeSliderDate(start);
                              setTimeAutoPlaying(true);
                              timeAutoPlayRef.current = setInterval(() => {
                                current += increment;
                                if (current >= end) {
                                  clearInterval(timeAutoPlayRef.current);
                                  timeAutoPlayRef.current = null;
                                  setTimeSliderDate(null);
                                  setTimeAutoPlaying(false);
                                } else {
                                  setTimeSliderDate(current);
                                }
                              }, stepMs);
                            }
                          }}
                          style={{ fontSize: 10, padding: "2px 10px", background: timeAutoPlaying ? "#ff4a4a22" : "#4aff9e22", color: timeAutoPlaying ? "#ff4a4a" : "#4aff9e", border: `1px solid ${timeAutoPlaying ? "#ff4a4a44" : "#4aff9e44"}`, borderRadius: 4, cursor: "pointer" }}
                        >
                          {timeAutoPlaying ? "Stop" : "Auto Play"}
                        </button>
                        <button
                          onClick={() => {
                            if (timeAutoPlayRef.current) { clearInterval(timeAutoPlayRef.current); timeAutoPlayRef.current = null; setTimeAutoPlaying(false); }
                            setTimeSliderDate(null);
                          }}
                          style={{ fontSize: 10, padding: "2px 10px", background: "rgba(255,255,255,0.06)", color: "var(--text-secondary)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, cursor: "pointer" }}
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {activeTab === "categories" && (
              <CategoryView onSelectEntity={handleSelectEntity} />
            )}

            {activeTab === "activity" && (
              <ActivityLog />
            )}

            {activeTab === "tokens" && (
              <TokenDashboard />
            )}

            {activeTab === "maintenance" && (
              <MaintenanceView />
            )}
          </div>

          {/* Detail Panel */}
          {entityDetail && (
            <div className="detail-panel-wrapper">
              <DetailPanel
                entity={entityDetail.entity}
                relationships={entityDetail.relationships}
                onClose={closeDetail}
                onNavigate={(name) => { navigateToEntity(name); handleSelectEntity(name); }}
                groupColors={catColors}
                onRefresh={() => { handleRefresh(); if (entityDetail?.entity?.name) handleSelectEntity(entityDetail.entity.name); }}
                onEntityUpdate={() => { handleRefresh(); if (entityDetail?.entity?.name) handleSelectEntity(entityDetail.entity.name); }}
                categoryColors={catColors}
                onViewGraph={handleViewGraph}
                onDeleteNode={(name) => {
                  setGraphData(prev => {
                    const nodes = prev.nodes.filter(n => n.name !== name);
                    const ids = new Set(nodes.map(n => n.id));
                    const links = prev.links.filter(l => {
                      const s = typeof l.source === "object" ? l.source.id : l.source;
                      const t = typeof l.target === "object" ? l.target.id : l.target;
                      return ids.has(s) && ids.has(t);
                    });
                    return { nodes, links };
                  });
                  setEntityDetail(null);
                  setSelectedNode(null);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
