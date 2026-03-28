import { useState, useCallback, useRef, useEffect } from "react";
import { EntityActivityHistory } from "./ActivityLog";
import { CATEGORY_COLORS, CATEGORY_LABELS, NODE_TYPES } from "../constants";
import EvolveModal from "./EvolveModal";

function TagEditor({ tags, entityName, onTagsChanged }) {
  const [adding, setAdding] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (adding && inputRef.current) inputRef.current.focus();
  }, [adding]);

  const saveTags = async (newTags) => {
    const normalized = [...new Set(newTags.filter(t => t.trim()).map(t => t.toLowerCase().trim()))].sort();
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entityName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: normalized }),
      });
      if (res.ok && onTagsChanged) onTagsChanged();
    } catch (err) {
      console.error("Failed to update tags:", err);
    }
  };

  const handleAdd = () => {
    const tag = inputValue.toLowerCase().trim();
    if (!tag) return;
    const merged = [...new Set([...tags, tag])].sort();
    setInputValue("");
    saveTags(merged);
  };

  const handleRemove = (tag) => {
    saveTags(tags.filter(t => t !== tag));
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleAdd(); }
    if (e.key === "Escape") { setAdding(false); setInputValue(""); }
  };

  return (
    <div className="tag-pills" style={{ margin: "8px 0" }}>
      {tags.map(tag => (
        <span key={tag} className="tag-pill">
          {tag}
          <button className="tag-remove" onClick={() => handleRemove(tag)}>✕</button>
        </span>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          className="tag-add-input"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => { if (!inputValue.trim()) setAdding(false); }}
          placeholder="tag name"
        />
      ) : (
        <button className="tag-add-btn" onClick={() => setAdding(true)}>+</button>
      )}
      {tags.length === 0 && !adding && (
        <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginLeft: 4 }}>(no tags)</span>
      )}
    </div>
  );
}

// Collapsible section wrapper
function Section({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 2 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 6,
          padding: "8px 0", background: "none", border: "none", cursor: "pointer",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--text-secondary)", transition: "transform 0.2s", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>&#9654;</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", flex: 1, textAlign: "left" }}>{title}</span>
        {count !== undefined && (
          <span style={{ fontSize: 10, color: "var(--text-secondary)", background: "rgba(255,255,255,0.06)", padding: "1px 6px", borderRadius: 8 }}>{count}</span>
        )}
      </button>
      {open && <div style={{ padding: "8px 0 4px" }}>{children}</div>}
    </div>
  );
}

// Toolbar icon button
function ToolBtn({ icon, label, onClick, active, disabled, color, activeColor, activeBg }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
        padding: "6px 4px", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer",
        background: active ? (activeBg || "rgba(74,158,255,0.15)") : "transparent",
        border: "none", transition: "all 0.15s",
        opacity: disabled ? 0.4 : 1, minWidth: 40,
      }}
    >
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ fontSize: 9, fontWeight: 600, color: active ? (activeColor || "#4a9eff") : (color || "var(--text-secondary)"), letterSpacing: 0.3 }}>{label}</span>
    </button>
  );
}

// Summary with truncation
function CollapsibleSummary({ entityName, savedSummary }) {
  const MAX_LINES = 3;
  const [expanded, setExpanded] = useState(false);
  const lines = (savedSummary || "").split("\n");
  const needsTruncate = lines.length > MAX_LINES || (savedSummary || "").length > 200;
  const displayText = !expanded && needsTruncate
    ? lines.slice(0, MAX_LINES).join("\n").slice(0, 200) + "..."
    : savedSummary;

  return (
    <EditableSummary
      entityName={entityName}
      savedSummary={savedSummary}
      displayText={displayText}
      truncated={!expanded && needsTruncate}
      onToggle={() => setExpanded(!expanded)}
    />
  );
}

function StrengthBar({ strength, lastAccessed, expiredAt }) {
  const s = strength ?? 1.0;
  const pct = Math.round(s * 100);
  const barColor = s > 0.6 ? "#4aff9e" : s > 0.3 ? "#ffdd4a" : "#ff4a4a";
  const label = expiredAt ? "Expired" : `${pct}%`;

  const lastAccessedText = lastAccessed
    ? `Last accessed: ${new Date(lastAccessed).toLocaleDateString()}`
    : null;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-secondary)", marginBottom: 3 }}>
        <span>Memory Strength</span>
        <span style={{ color: expiredAt ? "#ff4a4a" : barColor }}>{label}</span>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`,
          height: "100%",
          borderRadius: 2,
          background: expiredAt ? "#ff4a4a33" : barColor,
          transition: "width 0.3s ease",
        }} />
      </div>
      {lastAccessedText && (
        <div style={{ fontSize: 9, color: "var(--text-secondary)", marginTop: 2 }}>{lastAccessedText}</div>
      )}
    </div>
  );
}

export default function DetailPanel({ entity, relationships, onClose, onNavigate, groupColors, categoryColors, onRefresh, onEntityUpdate, onDeleteNode, onViewGraph }) {
  const [activeAction, setActiveAction] = useState(null);
  const [showEvolve, setShowEvolve] = useState(false);

  useEffect(() => {
    setShowEvolve(false);
    setActiveAction(null);
  }, [entity?.name]);

  if (!entity) return null;

  const outgoing = relationships.filter((r) => r.direction === "outgoing");
  const incoming = relationships.filter((r) => r.direction === "incoming");
  const totalRels = outgoing.length + incoming.length;

  return (
    <div className="detail-panel">
      <button className="close-btn" onClick={onClose}>✕</button>

      {/* === Title === */}
      <h2 style={{ marginBottom: 6 }}>{entity.name}</h2>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <CategorySelector entityName={entity.name} currentCategory={entity.category || entity.group_id} onRefresh={onEntityUpdate || onRefresh} />
        <NodeTypeSelector entityName={entity.name} currentNodeType={entity.node_type || "normal"} onRefresh={onEntityUpdate || onRefresh} />
        {entity.created_at && (
          <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>{formatDate(entity.created_at)}</span>
        )}
      </div>

      {/* === Compact Toolbar === */}
      <div style={{
        display: "flex", justifyContent: "space-around", padding: "4px 0 8px",
        borderBottom: "1px solid rgba(255,255,255,0.06)", marginBottom: 8,
      }}>
        <ToolBtn icon="✨" label="Evolve" onClick={() => setShowEvolve(true)} disabled={showEvolve} color="var(--accent-cyan)" />
        <ToolBtn icon="🕸️" label="Graph" onClick={() => onViewGraph && onViewGraph(entity.name)} />
        <ToolBtn icon="🔗" label="Link" onClick={() => setActiveAction(activeAction === "link" ? null : "link")} active={activeAction === "link"} activeColor="#66dd88" activeBg="rgba(74,255,120,0.12)" />
        <ToolBtn icon="🔀" label="Merge" onClick={() => setActiveAction(activeAction === "merge" ? null : "merge")} active={activeAction === "merge"} activeColor="#ffaa44" activeBg="rgba(255,165,0,0.12)" />
        <ToolBtn icon="🗑️" label="Delete" onClick={() => setActiveAction(activeAction === "delete" ? null : "delete")} active={activeAction === "delete"} activeColor="#ff4a4a" activeBg="rgba(255,74,74,0.12)" />
      </div>

      {/* Action panels (inline, shown when active) */}
      {activeAction === "delete" && (
        <DeletePanel entityName={entity.name} onDone={() => { setActiveAction(null); if (onDeleteNode) onDeleteNode(entity.name); onClose(); }} onCancel={() => setActiveAction(null)} />
      )}
      {activeAction && activeAction !== "delete" && (
        <ActionPanel mode={activeAction} entityName={entity.name} onDone={(result) => { setActiveAction(null); if (onRefresh) onRefresh(); if (result?.kept && onNavigate) onNavigate(result.kept); }} onCancel={() => setActiveAction(null)} />
      )}

      {/* === Memory Strength === */}
      <StrengthBar
        strength={entity.strength}
        lastAccessed={entity.last_accessed_at}
        expiredAt={entity.expired_at}
      />

      {/* === Tags === */}
      <TagEditor tags={entity.tags || []} entityName={entity.name} onTagsChanged={onEntityUpdate || onRefresh} />

      {/* === Summary (collapsible) === */}
      <Section title="Summary" defaultOpen={true}>
        <CollapsibleSummary entityName={entity.name} savedSummary={entity.summary || ""} />
      </Section>

      {/* === AI Explanation (collapsed) === */}
      <Section title="AI Explanation" defaultOpen={false}>
        <ExplanationSection entityName={entity.name} savedExplanation={entity.explanation} explanationUpdatedAt={entity.explanation_updated_at} />
      </Section>

      {/* === Relationships (collapsed) === */}
      <Section title="Relationships" count={totalRels} defaultOpen={false}>
        {outgoing.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>→ Outgoing ({outgoing.length})</div>
            {outgoing.map((rel, i) => (
              <RelationshipItem key={`out-${i}`} rel={rel} direction="outgoing" isCredential={entity.node_type === "credential"} onNavigate={onNavigate} />
            ))}
          </>
        )}
        {incoming.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", margin: "8px 0 4px" }}>← Incoming ({incoming.length})</div>
            {incoming.map((rel, i) => (
              <RelationshipItem key={`in-${i}`} rel={rel} direction="incoming" isCredential={rel.other?.node_type === "credential"} onNavigate={onNavigate} />
            ))}
          </>
        )}
        {totalRels === 0 && (
          <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>No relationships found.</div>
        )}
      </Section>

      {/* === Activity (collapsed) === */}
      <Section title="Activity" defaultOpen={false}>
        <EntityActivityHistory entityName={entity.name} />
      </Section>

      {showEvolve && (
        <EvolveModal entityName={entity.name} onClose={() => setShowEvolve(false)} onSaved={() => { setShowEvolve(false); if (onRefresh) onRefresh(); }} />
      )}
    </div>
  );
}

function EditableSummary({ entityName, savedSummary, displayText, truncated, onToggle }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(savedSummary);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  // Reset when entity changes
  useEffect(() => {
    setValue(savedSummary);
    setEditing(false);
  }, [entityName, savedSummary]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, [editing]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entityName)}/summary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: value }),
      });
      if (!res.ok) throw new Error("Save failed");
      setEditing(false);
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }, [entityName, value]);

  if (editing) {
    return (
      <div style={{ marginBottom: 12 }}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = e.target.scrollHeight + "px";
          }}
          style={{
            width: "100%",
            minHeight: 60,
            padding: 10,
            background: "var(--bg-secondary)",
            border: "1px solid rgba(74, 158, 255, 0.3)",
            borderRadius: 8,
            color: "var(--text-primary)",
            fontSize: 13,
            lineHeight: 1.5,
            resize: "none",
            outline: "none",
            fontFamily: "inherit",
            boxSizing: "border-box",
          }}
          placeholder="Add a summary for this entity..."
        />
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "4px 12px",
              background: "var(--accent-blue)",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              fontSize: 12,
              cursor: saving ? "wait" : "pointer",
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={() => { setValue(savedSummary); setEditing(false); }}
            style={{
              padding: "4px 12px",
              background: "none",
              border: "1px solid var(--text-secondary)",
              borderRadius: 6,
              color: "var(--text-secondary)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const shownText = displayText !== undefined ? displayText : value;

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={() => setEditing(true)}
        title="Click to edit summary"
        style={{
          padding: value ? "6px 8px" : "6px 8px",
          background: value ? "transparent" : "var(--bg-secondary)",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 13,
          color: value ? "var(--text-primary)" : "var(--text-secondary)",
          lineHeight: 1.5,
          borderLeft: value ? "2px solid rgba(74, 158, 255, 0.3)" : "2px solid transparent",
          transition: "all 0.2s",
          whiteSpace: "pre-wrap",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderLeftColor = "var(--accent-blue)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderLeftColor = value ? "rgba(74, 158, 255, 0.3)" : "transparent"; }}
      >
        {shownText || "Click to add summary..."}
      </div>
      {(truncated !== undefined) && value && (
        <button
          onClick={(e) => { e.stopPropagation(); if (onToggle) onToggle(); }}
          style={{
            background: "none", border: "none", color: "var(--accent-blue)",
            fontSize: 11, cursor: "pointer", padding: "2px 8px", marginTop: 2,
          }}
        >{truncated ? "Show more" : "Show less"}</button>
      )}
    </div>
  );
}

function ExplanationSection({ entityName, savedExplanation, explanationUpdatedAt }) {
  const [explanation, setExplanation] = useState(savedExplanation || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);

  // Reset when entity changes
  useEffect(() => {
    setExplanation(savedExplanation || null);
    setMeta(null);
    setError(null);
    setLoading(false);
  }, [entityName, savedExplanation]);

  const handleAnalyze = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entityName)}/summarize`);
      if (!res.ok) throw new Error("Analysis failed");
      const data = await res.json();
      setExplanation(data.explanation);
      setMeta({ connected: data.connectedCount, relationships: data.relationshipCount });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [entityName]);

  const hasExplanation = explanation && explanation.length > 0;

  return (
    <div style={{ marginBottom: 16 }}>
      {!hasExplanation && !loading && !error && (
        <button
          onClick={handleAnalyze}
          style={{
            width: "100%",
            padding: "10px 16px",
            background: "linear-gradient(135deg, rgba(74, 158, 255, 0.15), rgba(158, 74, 255, 0.15))",
            border: "1px solid rgba(74, 158, 255, 0.3)",
            borderRadius: 8,
            color: "var(--accent-blue)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            transition: "all 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "linear-gradient(135deg, rgba(74, 158, 255, 0.25), rgba(158, 74, 255, 0.25))";
            e.currentTarget.style.borderColor = "rgba(74, 158, 255, 0.5)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "linear-gradient(135deg, rgba(74, 158, 255, 0.15), rgba(158, 74, 255, 0.15))";
            e.currentTarget.style.borderColor = "rgba(74, 158, 255, 0.3)";
          }}
        >
          ✨ Analyze Entity
        </button>
      )}

      {loading && (
        <div style={{
          padding: 16,
          textAlign: "center",
          color: "var(--text-secondary)",
          fontSize: 13,
          background: "var(--bg-secondary)",
          borderRadius: 8,
        }}>
          <div className="loading-spinner" style={{ width: 20, height: 20, margin: "0 auto 8px" }} />
          Analyzing connections...
        </div>
      )}

      {error && (
        <div style={{
          padding: 12,
          background: "rgba(255, 74, 74, 0.1)",
          border: "1px solid var(--accent-red)",
          borderRadius: 8,
          color: "var(--accent-red)",
          fontSize: 13,
        }}>
          {error}
          <button
            onClick={handleAnalyze}
            style={{
              marginLeft: 8,
              background: "none",
              border: "none",
              color: "var(--accent-blue)",
              cursor: "pointer",
              fontSize: 12,
              textDecoration: "underline",
            }}
          >
            Retry
          </button>
        </div>
      )}

      {hasExplanation && !loading && (
        <div style={{
          padding: 14,
          background: "linear-gradient(135deg, rgba(74, 158, 255, 0.08), rgba(158, 74, 255, 0.08))",
          border: "1px solid rgba(74, 158, 255, 0.15)",
          borderRadius: 8,
        }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-blue)" }}>
              ✨ AI Explanation
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {meta && (
                <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                  {meta.connected} entities • {meta.relationships} rels
                </span>
              )}
              {explanationUpdatedAt && !meta && (
                <span style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                  {formatDate(explanationUpdatedAt)}
                </span>
              )}
              <button
                onClick={handleAnalyze}
                title="Refresh explanation"
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "2px 4px",
                  borderRadius: 4,
                  transition: "color 0.2s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent-blue)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-secondary)"; }}
              >
                🔄
              </button>
            </div>
          </div>
          <div style={{
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--text-primary)",
          }}>
            {explanation}
          </div>
        </div>
      )}
    </div>
  );
}

function DeletePanel({ entityName, onDone, onCancel }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/entity/${encodeURIComponent(entityName)}/delete-preview`)
      .then(r => r.json())
      .then(data => { setPreview(data); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [entityName]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entityName)}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error || "Delete failed");
      onDone();
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  }, [entityName, onDone]);

  return (
    <div style={{
      marginTop: 12, padding: 14,
      background: "rgba(255,74,74,0.08)", border: "1px solid rgba(255,74,74,0.25)",
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#ff4a4a", marginBottom: 10 }}>
        🗑️ Delete "{entityName}"
      </div>

      {error && <div style={{ fontSize: 12, color: "#ff4a4a", marginBottom: 8 }}>{error}</div>}

      {loading && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Loading preview...</div>}

      {preview && (
        <>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
            This will permanently delete this entity and remove:
          </div>

          {preview.relationships.length > 0 && (
            <div style={{
              maxHeight: 150, overflowY: "auto", marginBottom: 10,
              background: "rgba(0,0,0,0.2)", borderRadius: 6, padding: 8,
            }}>
              {preview.relationships.map((r, i) => (
                <div key={i} style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>
                  <span style={{ color: "#ff8888" }}>{r.direction === "outgoing" ? "→" : "←"}</span>
                  {" "}
                  <span style={{ color: "var(--text-primary)" }}>[{r.relation}]</span>
                  {" "}
                  {r.otherName}
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 12 }}>
            <strong>{preview.relationships.length}</strong> relationship{preview.relationships.length !== 1 ? "s" : ""}
            {preview.episodicLinks > 0 && <> · <strong>{preview.episodicLinks}</strong> episodic link{preview.episodicLinks !== 1 ? "s" : ""}</>}
            {" will be removed."}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleDelete} disabled={deleting} style={{
              flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: deleting ? "wait" : "pointer", opacity: deleting ? 0.6 : 1,
              background: "rgba(255,74,74,0.2)", border: "1px solid rgba(255,74,74,0.5)",
              color: "#ff4a4a",
            }}>
              {deleting ? "Deleting..." : "Confirm Delete"}
            </button>
            <button onClick={onCancel} style={{
              padding: "8px 12px", borderRadius: 8, fontSize: 12,
              background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
              color: "var(--text-secondary)", cursor: "pointer",
            }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

function RelationshipItem({ rel, direction, isCredential, onNavigate }) {
  const [revealed, setRevealed] = useState(false);

  if (direction === "outgoing") {
    return (
      <div className="relationship-item" onClick={() => onNavigate(rel.other.name)}>
        <div>
          <span className="relationship-label">{rel._type || "RELATES_TO"}</span>
          {" → "}
          <span className="relationship-target">{rel.other.name}</span>
        </div>
        {rel.fact && (
          <div
            className="relationship-fact"
            onClick={isCredential ? (e) => { e.stopPropagation(); setRevealed(!revealed); } : undefined}
            style={isCredential ? { cursor: "pointer", userSelect: "none" } : {}}
          >
            {isCredential && !revealed ? "••••••" : rel.fact}
            {isCredential && (
              <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-secondary)" }}>
                {revealed ? "🔓" : "🔒"}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relationship-item" onClick={() => onNavigate(rel.other.name)}>
      <div>
        <span className="relationship-target">{rel.other.name}</span>
        {" → "}
        <span className="relationship-label">{rel._type || "RELATES_TO"}</span>
      </div>
      {rel.fact && (
        <div
          className="relationship-fact"
          onClick={isCredential ? (e) => { e.stopPropagation(); setRevealed(!revealed); } : undefined}
          style={isCredential ? { cursor: "pointer", userSelect: "none" } : {}}
        >
          {isCredential && !revealed ? "••••••" : rel.fact}
          {isCredential && (
            <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-secondary)" }}>
              {revealed ? "🔓" : "🔒"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function CategorySelector({ entityName, currentCategory, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dynamicCategories, setDynamicCategories] = useState(null);
  const dropdownRef = useRef(null);

  // Fetch categories from API on first open
  useEffect(() => {
    if (!open || dynamicCategories) return;
    fetch("/api/categories")
      .then(r => r.json())
      .then(cats => { if (Array.isArray(cats)) setDynamicCategories(cats); })
      .catch(() => {});
  }, [open, dynamicCategories]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const handleSelect = useCallback(async (categoryKey) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entityName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: categoryKey || "" }),
      });
      if (res.ok) {
        setOpen(false);
        if (onRefresh) onRefresh();
      }
    } catch { /* skip */ }
    finally { setSaving(false); }
  }, [entityName, onRefresh]);

  const categoryEntries = [
    { key: "", label: "Auto-detect", color: "#888" },
    ...(dynamicCategories
      ? dynamicCategories.map(c => ({ key: c.key, label: c.label, color: c.color || "#888" }))
      : Object.entries(CATEGORY_LABELS).map(([key, label]) => ({ key, label, color: CATEGORY_COLORS[key] || "#888" }))
    ),
  ];

  const current = categoryEntries.find(g => g.key === (currentCategory || "")) || categoryEntries[0];

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600,
          cursor: "pointer", transition: "all 0.2s",
          background: `${current.color}20`,
          border: `1px solid ${current.color}40`,
          color: current.color,
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: current.color, display: "inline-block",
        }} />
        {current.label}
        <span style={{ fontSize: 9 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 30,
          marginTop: 4, background: "var(--bg-secondary)",
          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)", minWidth: 150,
          overflow: "hidden",
        }}>
          {categoryEntries.map(({ key, label, color }) => (
            <div
              key={key}
              onClick={() => !saving && handleSelect(key)}
              style={{
                padding: "8px 12px", cursor: saving ? "wait" : "pointer",
                fontSize: 12, display: "flex", alignItems: "center", gap: 8,
                background: key === (currentCategory || "") ? "rgba(74,158,255,0.1)" : "transparent",
                borderBottom: "1px solid rgba(255,255,255,0.03)",
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = "rgba(74,158,255,0.1)"}
              onMouseLeave={(e) => e.currentTarget.style.background = key === (currentCategory || "") ? "rgba(74,158,255,0.1)" : "transparent"}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NodeTypeSelector({ entityName, currentNodeType, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const handleSelect = useCallback(async (nodeType) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entityName)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_type: nodeType }),
      });
      if (res.ok) {
        setOpen(false);
        if (onRefresh) onRefresh();
      }
    } catch { /* skip */ }
    finally { setSaving(false); }
  }, [entityName, onRefresh]);

  const current = NODE_TYPES[currentNodeType] || NODE_TYPES.normal;
  const typeColor = currentNodeType === "credential" ? "#ff9e4a" : currentNodeType === "archived" ? "#8888aa" : "#4a9eff";

  return (
    <div ref={dropdownRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600,
          cursor: "pointer", transition: "all 0.2s",
          background: `${typeColor}20`,
          border: `1px solid ${typeColor}40`,
          color: typeColor,
        }}
      >
        {current.icon} {current.label}
        <span style={{ fontSize: 9 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, zIndex: 30,
          marginTop: 4, background: "var(--bg-secondary)",
          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8,
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)", minWidth: 140,
          overflow: "hidden",
        }}>
          {Object.entries(NODE_TYPES).map(([key, { label, icon }]) => {
            const color = key === "credential" ? "#ff9e4a" : key === "archived" ? "#8888aa" : "#4a9eff";
            return (
              <div
                key={key}
                onClick={() => !saving && handleSelect(key)}
                style={{
                  padding: "8px 12px", cursor: saving ? "wait" : "pointer",
                  fontSize: 12, display: "flex", alignItems: "center", gap: 8,
                  background: key === currentNodeType ? "rgba(74,158,255,0.1)" : "transparent",
                  borderBottom: "1px solid rgba(255,255,255,0.03)",
                  color: key === currentNodeType ? color : "var(--text-primary)",
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = "rgba(74,158,255,0.1)"}
                onMouseLeave={(e) => e.currentTarget.style.background = key === currentNodeType ? "rgba(74,158,255,0.1)" : "transparent"}
              >
                {icon} {label}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActionPanel({ mode, entityName, onDone, onCancel }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [target, setTarget] = useState(null);
  const [relationName, setRelationName] = useState("");
  const [fact, setFact] = useState("");
  const [keepName, setKeepName] = useState("target");
  const [summary, setSummary] = useState("");
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (search.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/entities?q=${encodeURIComponent(search)}&limit=8`);
        if (res.ok) {
          const data = await res.json();
          setResults((data.entities || []).filter(e => e.name !== entityName));
        }
      } catch { setResults([]); }
    }, 200);
    return () => clearTimeout(t);
  }, [search, entityName]);

  const selectTarget = useCallback(async (entity) => {
    try {
      const res = await fetch(`/api/entity/${encodeURIComponent(entity.name)}`);
      if (res.ok) {
        const data = await res.json();
        setTarget(data);
        setSearch("");
        setResults([]);
        if (mode === "merge") setSummary(data.entity?.summary || "");
      }
    } catch { /* skip */ }
  }, [mode]);

  const handleExecute = useCallback(async () => {
    if (!target) return;
    setExecuting(true);
    setError(null);
    try {
      if (mode === "link") {
        if (!relationName.trim()) { setError("Relation name required"); setExecuting(false); return; }
        const res = await fetch("/api/link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceName: entityName,
            targetName: target.entity.name,
            relationName: relationName.toUpperCase().replace(/\s+/g, "_"),
            fact: fact || undefined,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Link failed");
        onDone({ kept: entityName });
      } else {
        const keep = keepName === "current" ? entityName : target.entity.name;
        const merge = keepName === "current" ? target.entity.name : entityName;
        const res = await fetch("/api/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keepName: keep,
            mergeName: merge,
            newSummary: summary || undefined,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Merge failed");
        const data = await res.json();
        onDone(data);
      }
    } catch (err) {
      setError(err.message);
      setExecuting(false);
    }
  }, [mode, target, entityName, relationName, fact, keepName, summary, onDone]);

  const isLink = mode === "link";
  const accent = isLink ? "#66dd88" : "#ffaa44";
  const accentBg = isLink ? "rgba(74,255,120,0.1)" : "rgba(255,165,0,0.1)";

  return (
    <div style={{
      marginTop: 12, padding: 14, background: accentBg,
      border: `1px solid ${accent}33`, borderRadius: 10,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: accent, marginBottom: 10 }}>
        {isLink ? "🔗 Link to entity" : "🔀 Merge with entity"}
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "var(--accent-red)", marginBottom: 8 }}>{error}</div>
      )}

      {/* Search target */}
      {!target ? (
        <div style={{ position: "relative" }}>
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search entity..."
            style={{
              width: "100%", padding: "8px 12px", boxSizing: "border-box",
              background: "var(--bg-primary)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8, color: "var(--text-primary)", fontSize: 13, outline: "none",
            }}
          />
          {results.length > 0 && (
            <div style={{
              position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20,
              background: "var(--bg-secondary)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: "auto",
            }}>
              {results.map((e) => (
                <div key={e.uuid} onClick={() => selectTarget(e)} style={{
                  padding: "8px 12px", cursor: "pointer", fontSize: 13,
                  borderBottom: "1px solid rgba(255,255,255,0.03)",
                }}
                onMouseEnter={(ev) => ev.currentTarget.style.background = `${accent}15`}
                onMouseLeave={(ev) => ev.currentTarget.style.background = "transparent"}
                >
                  <div>{e.name}</div>
                  {e.summary && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                    {e.summary.slice(0, 60)}
                  </div>}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Target selected */}
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 12px", background: "var(--bg-primary)", borderRadius: 8, marginBottom: 10,
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{target.entity.name}</div>
              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                {(target.relationships || []).length} relationships
              </div>
            </div>
            <button onClick={() => { setTarget(null); setError(null); }} style={{
              background: "none", border: "none", color: "var(--text-secondary)",
              cursor: "pointer", fontSize: 13,
            }}>✕</button>
          </div>

          {/* Link options */}
          {isLink && (
            <>
              <input
                type="text"
                value={relationName}
                onChange={(e) => setRelationName(e.target.value)}
                placeholder="Relation (e.g. COMPETED_IN)"
                style={{
                  width: "100%", padding: "8px 12px", marginBottom: 8, boxSizing: "border-box",
                  background: "var(--bg-primary)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8, color: "var(--text-primary)", fontSize: 13, outline: "none",
                }}
              />
              <input
                type="text"
                value={fact}
                onChange={(e) => setFact(e.target.value)}
                placeholder="Description (optional)"
                style={{
                  width: "100%", padding: "8px 12px", marginBottom: 10, boxSizing: "border-box",
                  background: "var(--bg-primary)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8, color: "var(--text-primary)", fontSize: 13, outline: "none",
                }}
              />
            </>
          )}

          {/* Merge options */}
          {!isLink && (
            <>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>Keep name:</div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                {[
                  { key: "current", label: entityName },
                  { key: "target", label: target.entity.name },
                ].map(({ key, label }) => (
                  <button key={key} onClick={() => setKeepName(key)} style={{
                    flex: 1, padding: "6px 8px", borderRadius: 6, fontSize: 12,
                    cursor: "pointer", transition: "all 0.2s",
                    background: keepName === key ? `${accent}25` : "transparent",
                    border: `1px solid ${keepName === key ? accent : "rgba(255,255,255,0.1)"}`,
                    color: keepName === key ? accent : "var(--text-secondary)",
                  }}>{label}</button>
                ))}
              </div>
              <textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Summary (optional)"
                style={{
                  width: "100%", minHeight: 50, padding: 8, marginBottom: 10, boxSizing: "border-box",
                  background: "var(--bg-primary)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 8, color: "var(--text-primary)", fontSize: 12,
                  resize: "none", outline: "none", fontFamily: "inherit",
                }}
              />
            </>
          )}

          {/* Execute */}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleExecute} disabled={executing} style={{
              flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: executing ? "wait" : "pointer", opacity: executing ? 0.6 : 1,
              background: `${accent}25`, border: `1px solid ${accent}66`, color: accent,
            }}>
              {executing ? "..." : isLink ? "Create Link" : "Confirm Merge"}
            </button>
            <button onClick={onCancel} style={{
              padding: "8px 12px", borderRadius: 8, fontSize: 12,
              background: "transparent", border: "1px solid rgba(255,255,255,0.1)",
              color: "var(--text-secondary)", cursor: "pointer",
            }}>Cancel</button>
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
    return d.toLocaleDateString("en-NZ", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}
