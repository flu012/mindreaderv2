import { useState, useEffect, useCallback, useRef } from "react";
import { useCategoryColors } from "../useCategoryColors";

export default function ListView({ searchQuery, onSelectEntity }) {
  const { colors: CATEGORY_COLORS, labels: CATEGORY_LABELS } = useCategoryColors();
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeGroup, setActiveGroup] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const fetchRef = useRef(0);

  const fetchEntities = useCallback(async (q, group, off) => {
    const id = ++fetchRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        sort: "created_at", order: "desc", limit: String(limit), offset: String(off),
      });
      if (q) params.set("q", q);
      if (group) params.set("group", group);
      const res = await fetch(`/api/entities?${params}`);
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      if (id === fetchRef.current) {
        const data = await res.json();
        setEntities(data.entities);
        setTotal(data.total);
      }
    } catch (err) {
      console.error("Failed to load entities:", err);
      if (id === fetchRef.current) setError(err.message);
    } finally {
      if (id === fetchRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setOffset(0);
    fetchEntities(searchQuery, activeGroup, 0);
  }, [searchQuery, activeGroup, fetchEntities]);

  const handleGroupFilter = (group) => {
    setActiveGroup((prev) => (prev === group ? null : group));
  };

  const handlePageNext = () => {
    const newOffset = offset + limit;
    setOffset(newOffset);
    fetchEntities(searchQuery, activeGroup, newOffset);
  };

  const handlePagePrev = () => {
    const newOffset = Math.max(0, offset - limit);
    setOffset(newOffset);
    fetchEntities(searchQuery, activeGroup, newOffset);
  };

  return (
    <div className="list-view">
      <div className="list-filters">
        {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
          <button
            key={key}
            className={`filter-chip ${activeGroup === key ? "active" : ""}`}
            onClick={() => handleGroupFilter(key)}
          >
            <span className="dot" style={{ backgroundColor: CATEGORY_COLORS[key] }} />
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="list-empty" style={{ color: "#ff6b6b" }}>
          Failed to load entities: {error}
        </div>
      ) : loading ? (
        <div className="list-loading">
          <div className="loading-spinner" />
        </div>
      ) : entities.length === 0 ? (
        <div className="list-empty">No memories found.</div>
      ) : (
        <>
          <div className="list-items">
            {entities.map((entity) => (
              <div
                key={entity.uuid || entity.name}
                className="list-item"
                style={{ borderLeftColor: CATEGORY_COLORS[entity.category] || CATEGORY_COLORS.other }}
                onClick={() => onSelectEntity(entity.uuid || entity.name)}
              >
                <div className="list-item-header">
                  <span className="list-item-name">{entity.name}</span>
                  <span
                    className="list-item-badge"
                    style={{ backgroundColor: (CATEGORY_COLORS[entity.category] || CATEGORY_COLORS.other) + "22", color: CATEGORY_COLORS[entity.category] || CATEGORY_COLORS.other }}
                  >
                    {entity.category}
                  </span>
                </div>
                {entity.summary && (
                  <div className="list-item-summary">
                    {entity.summary.length > 150 ? entity.summary.slice(0, 150) + "..." : entity.summary}
                  </div>
                )}
                {entity.tags && entity.tags.length > 0 && (
                  <div className="tag-pills" style={{ marginTop: 4 }}>
                    {entity.tags.map(tag => (
                      <span key={tag} className="tag-pill tag-pill--small">{tag}</span>
                    ))}
                  </div>
                )}
                <div className="list-item-meta">
                  {entity.created_at && (
                    <span>{formatDate(entity.created_at)}</span>
                  )}
                  {entity.relCount > 0 && (
                    <span>{entity.relCount} connection{entity.relCount !== 1 ? "s" : ""}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="list-pagination">
            <button disabled={offset === 0} onClick={handlePagePrev}>Previous</button>
            <span className="list-pagination-info">
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <button disabled={offset + limit >= total} onClick={handlePageNext}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-NZ", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}
