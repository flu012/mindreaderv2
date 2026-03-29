import { useState, useEffect } from "react";
import { GROUP_COLORS } from "../constants";

export default function ProjectView({ searchQuery, onSelectEntity }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectEntities, setProjectEntities] = useState([]);
  const [loadingEntities, setLoadingEntities] = useState(false);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => {
        if (!r.ok) throw new Error(`Server error: ${r.status}`);
        return r.json();
      })
      .then((data) => { setProjects(data.projects || []); setLoading(false); })
      .catch((err) => { console.error("Failed to load projects:", err); setError(err.message); setLoading(false); });
  }, []);

  const handleProjectClick = async (project) => {
    if (selectedProject === project.name) {
      setSelectedProject(null);
      setProjectEntities([]);
      return;
    }
    setSelectedProject(project.name);
    setLoadingEntities(true);
    try {
      const res = await fetch(`/api/graph?project=${encodeURIComponent(project.name)}&limit=100`);
      if (res.ok) {
        const data = await res.json();
        setProjectEntities(data.nodes || []);
      }
    } catch (err) {
      console.error("Failed to load project entities:", err);
    } finally {
      setLoadingEntities(false);
    }
  };

  if (loading) {
    return <div className="list-loading"><div className="loading-spinner" /></div>;
  }

  if (error) {
    return <div className="list-empty" style={{ color: "#ff6b6b" }}>Failed to load projects: {error}</div>;
  }

  const q = searchQuery?.toLowerCase() || "";
  const filtered = q
    ? projects.filter((p) => (p.name || "").toLowerCase().includes(q) || (p.summary || "").toLowerCase().includes(q))
    : projects;

  if (filtered.length === 0) {
    return <div className="list-empty">No projects found.</div>;
  }

  return (
    <div className="project-view">
      <div className="project-cards">
        {filtered.map((project, i) => (
          <div
            key={project.uuid || i}
            className={`project-card ${selectedProject === project.name ? "active" : ""}`}
            onClick={() => handleProjectClick(project)}
          >
            <div className="project-card-header">
              <span className="project-card-name">{project.name}</span>
            </div>
            {project.summary && (
              <div className="project-card-summary">
                {project.summary.length > 100 ? project.summary.slice(0, 100) + "..." : project.summary}
              </div>
            )}
            {project.created_at && (
              <div className="project-card-meta">
                Created {formatDate(project.created_at)}
              </div>
            )}
          </div>
        ))}
      </div>

      {selectedProject && (
        <div className="project-entities">
          <h3 className="project-entities-title">
            Entities related to "{selectedProject}"
          </h3>
          {loadingEntities ? (
            <div className="list-loading"><div className="loading-spinner" /></div>
          ) : projectEntities.length === 0 ? (
            <div className="list-empty">No related entities found.</div>
          ) : (
            <div className="list-items">
              {projectEntities.map((entity) => (
                <div
                  key={entity.id || entity.name}
                  className="list-item"
                  style={{ borderLeftColor: GROUP_COLORS[entity.group] || "#8888aa" }}
                  onClick={() => onSelectEntity(entity.uuid || entity.id || entity.name)}
                >
                  <div className="list-item-header">
                    <span className="list-item-name">{entity.name}</span>
                    <span
                      className="list-item-badge"
                      style={{ backgroundColor: (GROUP_COLORS[entity.group] || "#8888aa") + "22", color: GROUP_COLORS[entity.group] || "#8888aa" }}
                    >
                      {entity.group}
                    </span>
                  </div>
                  {entity.summary && (
                    <div className="list-item-summary">
                      {entity.summary.length > 120 ? entity.summary.slice(0, 120) + "..." : entity.summary}
                    </div>
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

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString("en-NZ", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}
