import { useState, useEffect, useCallback } from "react";
import { CATEGORY_COLORS, CATEGORY_LABELS, COLOR_PALETTE } from "../constants";

// ─── Category Form (Create / Edit) ───────────────────────────────────────────

function CategoryForm({ initial = {}, onSave, onCancel, existingKeys = [] }) {
  const [key, setKey] = useState(initial.key || "");
  const [label, setLabel] = useState(initial.label || "");
  const [color, setColor] = useState(initial.color || "#4aff9e");
  const [keywords, setKeywords] = useState(initial.keywords || "");
  const [order, setOrder] = useState(initial.order || 50);
  const [error, setError] = useState("");
  const isEdit = !!initial.key;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!label.trim()) { setError("Label is required"); return; }
    if (!isEdit) {
      if (!key.trim()) { setError("Key is required"); return; }
      if (key === "other") { setError("'other' is a reserved key"); return; }
      if (existingKeys.includes(key)) { setError(`Key '${key}' already exists`); return; }
    }
    setError("");
    onSave({ key: key.trim(), label: label.trim(), color, keywords: keywords.trim(), order: Number(order) });
  };

  return (
    <form onSubmit={handleSubmit} style={{
      background: "rgba(10, 10, 30, 0.95)",
      border: "1px solid rgba(74, 158, 255, 0.2)",
      borderRadius: 10,
      padding: "20px 24px",
      marginBottom: 16,
      display: "flex",
      flexDirection: "column",
      gap: 14,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
        {isEdit ? `Edit Category: ${initial.label}` : "New Category"}
      </div>

      {!isEdit && (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1 }}>Key (unique ID)</span>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
            placeholder="e.g. person, project"
            style={inputStyle}
          />
        </label>
      )}

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1 }}>Label</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Display name" style={inputStyle} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1 }}>Color</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
          {COLOR_PALETTE.map((c) => (
            <div
              key={c}
              onClick={() => setColor(c)}
              title={c}
              style={{
                width: 22, height: 22, borderRadius: "50%",
                background: c, cursor: "pointer",
                border: color === c ? "2px solid white" : "2px solid transparent",
                boxShadow: color === c ? `0 0 6px ${c}` : "none",
                transition: "all 0.15s",
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
          <span style={{ width: 16, height: 16, borderRadius: "50%", background: color, display: "inline-block" }} />
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{color}</span>
        </div>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1 }}>
          Keywords (comma-separated, for auto-detection)
        </span>
        <textarea
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="e.g. project, is a project, team"
          rows={3}
          style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 1 }}>Order</span>
        <input type="number" value={order} onChange={(e) => setOrder(e.target.value)} min={1} style={{ ...inputStyle, width: 80 }} />
      </label>

      {error && <div style={{ color: "#ff4a4a", fontSize: 13 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" style={btnPrimaryStyle}>Save</button>
        <button type="button" onClick={onCancel} style={btnSecondaryStyle}>Cancel</button>
      </div>
    </form>
  );
}

// ─── Merge Dialog ────────────────────────────────────────────────────────────

function MergeDialog({ categories, sourceKey, onConfirm, onCancel }) {
  const [targetKey, setTargetKey] = useState("");
  const source = categories.find((c) => c.key === sourceKey);
  const options = categories.filter((c) => c.key !== sourceKey);

  return (
    <div style={{
      background: "rgba(10, 10, 30, 0.97)",
      border: "1px solid rgba(255, 158, 74, 0.4)",
      borderRadius: 10,
      padding: "20px 24px",
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--text-primary)" }}>
        Merge "{source?.label}" into another category
      </div>
      <div style={{ marginBottom: 12, color: "var(--text-secondary)", fontSize: 13 }}>
        All entities in <b style={{ color: source?.color }}>{source?.label}</b> will be moved to the target category, and keywords will be merged.
      </div>
      <select
        value={targetKey}
        onChange={(e) => setTargetKey(e.target.value)}
        style={{ ...inputStyle, marginBottom: 12 }}
      >
        <option value="">— Select target category —</option>
        {options.map((c) => (
          <option key={c.key} value={c.key}>{c.label}</option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => targetKey && onConfirm(targetKey)}
          disabled={!targetKey}
          style={{ ...btnPrimaryStyle, background: targetKey ? "#ff9e4a" : "#555" }}
        >
          Merge
        </button>
        <button onClick={onCancel} style={btnSecondaryStyle}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Delete Confirmation ──────────────────────────────────────────────────────

function DeleteConfirm({ category, onConfirm, onCancel }) {
  return (
    <div style={{
      background: "rgba(30, 10, 10, 0.97)",
      border: "1px solid rgba(255, 74, 74, 0.4)",
      borderRadius: 10,
      padding: "16px 20px",
      marginBottom: 12,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, color: "#ff4a4a" }}>
        Delete "{category.label}"?
      </div>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
        This will move <b>{category.count}</b> {category.count === 1 ? "entity" : "entities"} to Other. Continue?
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onConfirm} style={{ ...btnPrimaryStyle, background: "#ff4a4a" }}>Delete</button>
        <button onClick={onCancel} style={btnSecondaryStyle}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Category Card ────────────────────────────────────────────────────────────

function CategoryCard({ category, onSelectEntity, onEdit, onDelete, onMerge }) {
  const [expanded, setExpanded] = useState(false);
  const [entities, setEntities] = useState(null);
  const [loadingEntities, setLoadingEntities] = useState(false);

  const color = category.color || CATEGORY_COLORS[category.key] || "#8888aa";
  const label = category.label || CATEGORY_LABELS[category.key] || category.key;
  const isOther = category.key === "other";

  const handleExpand = useCallback(async () => {
    if (!expanded && entities === null) {
      setLoadingEntities(true);
      try {
        const res = await fetch(`/api/categories/${encodeURIComponent(category.key)}/entities`);
        if (res.ok) setEntities(await res.json());
      } catch {}
      setLoadingEntities(false);
    }
    setExpanded((v) => !v);
  }, [expanded, entities, category.key]);

  return (
    <div style={{
      border: `1px solid ${color}33`,
      borderRadius: 10,
      marginBottom: 10,
      overflow: "hidden",
      background: "rgba(10, 10, 26, 0.6)",
    }}>
      {/* Header */}
      <div
        onClick={handleExpand}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 14px",
          cursor: "pointer",
          background: expanded ? `${color}15` : "transparent",
          transition: "background 0.2s",
          userSelect: "none",
        }}
      >
        <span style={{
          width: 12, height: 12, borderRadius: "50%",
          background: color, flexShrink: 0,
          boxShadow: `0 0 6px ${color}88`,
        }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", flex: 1 }}>
          {label}
        </span>
        <span style={{
          fontSize: 12, color: "var(--text-secondary)",
          background: "rgba(255,255,255,0.06)",
          borderRadius: 12, padding: "2px 8px",
          minWidth: 28, textAlign: "center",
        }}>
          {category.count ?? 0}
        </span>
        {!isOther && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onMerge(category.key); }}
              title="Merge into another category"
              style={iconBtnStyle}
            >🔀</button>
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(category); }}
              title="Edit"
              style={iconBtnStyle}
            >✏️</button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(category); }}
              title="Delete"
              style={{ ...iconBtnStyle, color: "#ff4a4a" }}
            >🗑️</button>
          </>
        )}
        {isOther && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(category); }}
            title="Edit label/color"
            style={iconBtnStyle}
          >✏️</button>
        )}
        <span style={{ color: "var(--text-secondary)", fontSize: 12, marginLeft: 2 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>

      {/* Entity list */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${color}22` }}>
          {loadingEntities && (
            <div style={{ padding: "10px 16px", color: "var(--text-secondary)", fontSize: 13 }}>Loading…</div>
          )}
          {!loadingEntities && entities && entities.length === 0 && (
            <div style={{ padding: "10px 16px", color: "var(--text-secondary)", fontSize: 13, fontStyle: "italic" }}>
              No entities
            </div>
          )}
          {!loadingEntities && entities && entities.length > 0 && (
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {entities.map((e) => (
                <div
                  key={e.uuid || e.name}
                  onClick={() => onSelectEntity(e.uuid || e.name)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 16px",
                    cursor: "pointer",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(ev) => ev.currentTarget.style.background = "rgba(255,255,255,0.06)"}
                  onMouseLeave={(ev) => ev.currentTarget.style.background = "transparent"}
                >
                  {e.node_type === "credential" && <span style={{ fontSize: 11 }}>🔒</span>}
                  {e.node_type === "archived" && <span style={{ fontSize: 11 }}>📦</span>}
                  <span style={{ fontSize: 13, color: "var(--text-primary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.name}
                  </span>
                  {e.summary && (
                    <span style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                      {e.summary.slice(0, 80)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main CategoryView ────────────────────────────────────────────────────────

export default function CategoryView({ onSelectEntity }) {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [deletingCategory, setDeletingCategory] = useState(null);
  const [mergingKey, setMergingKey] = useState(null);
  const [busy, setBusy] = useState(false);

  const fetchCategories = useCallback(async () => {
    try {
      const res = await fetch("/api/categories");
      if (res.ok) {
        const data = await res.json();
        setCategories(data.sort((a, b) => (a.order || 99) - (b.order || 99)));
      }
    } catch (err) {
      setError("Failed to load categories");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const handleCreate = useCallback(async (data) => {
    setBusy(true);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to create category");
        return;
      }
      setShowCreateForm(false);
      await fetchCategories();
    } finally {
      setBusy(false);
    }
  }, [fetchCategories]);

  const handleEdit = useCallback(async (data) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/categories/${encodeURIComponent(editingCategory.key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to update category");
        return;
      }
      setEditingCategory(null);
      await fetchCategories();
    } finally {
      setBusy(false);
    }
  }, [editingCategory, fetchCategories]);

  const handleDelete = useCallback(async () => {
    if (!deletingCategory) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/categories/${encodeURIComponent(deletingCategory.key)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to delete category");
        return;
      }
      setDeletingCategory(null);
      await fetchCategories();
    } finally {
      setBusy(false);
    }
  }, [deletingCategory, fetchCategories]);

  const handleMerge = useCallback(async (targetKey) => {
    setBusy(true);
    try {
      const res = await fetch("/api/categories/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceKey: mergingKey, targetKey }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to merge categories");
        return;
      }
      setMergingKey(null);
      await fetchCategories();
    } finally {
      setBusy(false);
    }
  }, [mergingKey, fetchCategories]);

  if (loading) {
    return (
      <div style={{ padding: 32, color: "var(--text-secondary)", textAlign: "center" }}>
        <div className="loading-spinner" style={{ margin: "0 auto 12px" }} />
        Loading categories…
      </div>
    );
  }

  return (
    <div style={{ padding: "20px 24px", maxWidth: 800, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>
            🏷️ Categories
          </h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            {categories.length} categories · {categories.reduce((s, c) => s + (c.count || 0), 0)} entities
          </div>
        </div>
        <button
          onClick={() => { setShowCreateForm(true); setEditingCategory(null); }}
          style={btnPrimaryStyle}
          disabled={busy}
        >
          + New Category
        </button>
      </div>

      {error && <div style={{ color: "#ff4a4a", marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {/* Create form */}
      {showCreateForm && (
        <CategoryForm
          existingKeys={categories.map((c) => c.key)}
          onSave={handleCreate}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* Edit form */}
      {editingCategory && (
        <CategoryForm
          initial={editingCategory}
          onSave={handleEdit}
          onCancel={() => setEditingCategory(null)}
        />
      )}

      {/* Merge dialog */}
      {mergingKey && (
        <MergeDialog
          categories={categories}
          sourceKey={mergingKey}
          onConfirm={handleMerge}
          onCancel={() => setMergingKey(null)}
        />
      )}

      {/* Delete confirmation */}
      {deletingCategory && (
        <DeleteConfirm
          category={deletingCategory}
          onConfirm={handleDelete}
          onCancel={() => setDeletingCategory(null)}
        />
      )}

      {/* Category cards */}
      {categories.map((cat) => (
        <CategoryCard
          key={cat.key}
          category={cat}
          onSelectEntity={onSelectEntity}
          onEdit={(c) => { setEditingCategory(c); setShowCreateForm(false); }}
          onDelete={(c) => setDeletingCategory(c)}
          onMerge={(key) => setMergingKey(key)}
        />
      ))}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const inputStyle = {
  background: "rgba(255, 255, 255, 0.06)",
  border: "1px solid rgba(74, 158, 255, 0.2)",
  borderRadius: 6,
  padding: "8px 10px",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const btnPrimaryStyle = {
  background: "linear-gradient(135deg, rgba(74, 158, 255, 0.8), rgba(74, 255, 158, 0.5))",
  border: "none",
  borderRadius: 8,
  padding: "8px 16px",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const btnSecondaryStyle = {
  background: "rgba(255, 255, 255, 0.08)",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  borderRadius: 8,
  padding: "8px 16px",
  color: "var(--text-secondary)",
  fontSize: 13,
  cursor: "pointer",
};

const iconBtnStyle = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 14,
  padding: "2px 4px",
  borderRadius: 4,
  color: "var(--text-secondary)",
  lineHeight: 1,
};
