import { useState, useEffect } from "react";
import { useCategoryColors } from "../useCategoryColors";

const SECTION_LABELS = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This Week",
  earlier: "Earlier",
};

export default function TimelineView({ searchQuery, onSelectEntity, refreshKey }) {
  const { colors: CATEGORY_COLORS } = useCategoryColors();
  const [timeline, setTimeline] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch("/api/timeline?days=90")
      .then((r) => {
        if (!r.ok) throw new Error(`Server error: ${r.status}`);
        return r.json();
      })
      .then((data) => { setTimeline(data.timeline); setLoading(false); })
      .catch((err) => { console.error("Failed to load timeline:", err); setError(err.message); setLoading(false); });
  }, [refreshKey]);

  if (loading) {
    return <div className="list-loading"><div className="loading-spinner" /></div>;
  }

  if (error) {
    return <div className="list-empty" style={{ color: "#ff6b6b" }}>Failed to load timeline: {error}</div>;
  }

  if (!timeline) {
    return <div className="list-empty">Failed to load timeline.</div>;
  }

  const q = searchQuery?.toLowerCase() || "";
  const filterEntity = (e) => {
    if (!q) return true;
    return (e.name || "").toLowerCase().includes(q) || (e.summary || "").toLowerCase().includes(q);
  };

  const sections = ["today", "yesterday", "this_week", "earlier"];
  const hasAny = sections.some((s) => timeline[s]?.filter(filterEntity).length > 0);

  if (!hasAny) {
    return <div className="list-empty">No memories in timeline.</div>;
  }

  return (
    <div className="timeline-view">
      {sections.map((section) => {
        const items = (timeline[section] || []).filter(filterEntity);
        if (items.length === 0) return null;
        return (
          <div key={section} className="timeline-section">
            <div className="timeline-section-header">
              <span className="timeline-section-label">{SECTION_LABELS[section]}</span>
              <span className="timeline-section-count">{items.length}</span>
            </div>
            <div className="timeline-items">
              {items.map((entity, i) => (
                <div
                  key={entity.uuid || `${section}-${i}`}
                  className="timeline-item"
                  onClick={() => onSelectEntity(entity.uuid || entity.name)}
                >
                  <div className="timeline-dot" style={{ backgroundColor: CATEGORY_COLORS[entity.category] || CATEGORY_COLORS.other }} />
                  <div className="timeline-content">
                    <div className="timeline-item-header">
                      <span className="timeline-item-name">{entity.name}</span>
                      {entity.created_at && (
                        <span className="timeline-item-time">{formatTime(entity.created_at)}</span>
                      )}
                    </div>
                    {entity.summary && (
                      <div className="timeline-item-summary">
                        {entity.summary.length > 120 ? entity.summary.slice(0, 120) + "..." : entity.summary}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatTime(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}
