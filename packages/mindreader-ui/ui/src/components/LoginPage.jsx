import { useState } from "react";

export default function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a14", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 360, padding: 32, background: "rgba(255,255,255,0.02)", borderRadius: 16, border: "1px solid rgba(255,255,255,0.06)" }}>
        <h1 style={{ color: "#e0e0e8", fontSize: 22, textAlign: "center", marginBottom: 4 }}>
          <span style={{ background: "linear-gradient(135deg, #4aff9e, #4a9eff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>MindReader</span>
        </h1>
        <p style={{ color: "#666", textAlign: "center", marginBottom: 24, fontSize: 13 }}>Sign in to your knowledge graph</p>

        {error && <div style={{ padding: "8px 12px", background: "#ff4a4a22", color: "#ff4a4a", borderRadius: 6, marginBottom: 16, fontSize: 12 }}>{error}</div>}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required
            style={{ width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#e0e0e8", fontSize: 14, boxSizing: "border-box" }} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required
            style={{ width: "100%", padding: "10px 14px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#e0e0e8", fontSize: 14, boxSizing: "border-box" }} />
          <button type="submit" disabled={loading}
            style={{ width: "100%", padding: "10px", background: loading ? "#333" : "#4aff9e", color: "#0a0a14", border: "none", borderRadius: 8, fontWeight: 700, fontSize: 15, cursor: loading ? "default" : "pointer" }}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
