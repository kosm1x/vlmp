import { h } from "https://unpkg.com/preact@10/dist/preact.module.js";
import {
  useState,
  useEffect,
} from "https://unpkg.com/preact@10/hooks/dist/hooks.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { get, post } from "../api.js";
const html = htm.bind(h);

export function HealthDashboard() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cleaning, setCleaning] = useState(false);

  function loadReport() {
    setLoading(true);
    get("/admin/health")
      .then((data) => {
        setReport(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }

  useEffect(loadReport, []);

  async function handleCleanup() {
    if (
      !confirm("Remove all orphaned database entries? This cannot be undone.")
    )
      return;
    setCleaning(true);
    try {
      const result = await post("/admin/health/cleanup");
      alert(`Removed ${result.removed} orphaned entries.`);
      loadReport();
    } catch (e) {
      alert(e.message);
    }
    setCleaning(false);
  }

  if (loading)
    return html`<div class="health-page">
      <div class="loading">Loading health report...</div>
    </div>`;
  if (error)
    return html`<div class="health-page">
      <div class="detail-error">${error}</div>
    </div>`;
  if (!report) return null;

  const s = report.summary;
  const cards = [
    { label: "Total Items", value: s.total_items, cls: "" },
    {
      label: "Missing Files",
      value: s.missing_files,
      cls: s.missing_files > 0 ? "health-error" : "health-ok",
    },
    {
      label: "Zero Byte",
      value: s.zero_byte_files,
      cls: s.zero_byte_files > 0 ? "health-warn" : "health-ok",
    },
    {
      label: "Metadata Gaps",
      value: s.metadata_gaps,
      cls: s.metadata_gaps > 0 ? "health-warn" : "health-ok",
    },
    {
      label: "No Subtitles",
      value: s.no_subtitles,
      cls: s.no_subtitles > 0 ? "health-warn" : "health-ok",
    },
    {
      label: "Orphaned",
      value: s.orphaned_entries,
      cls: s.orphaned_entries > 0 ? "health-error" : "health-ok",
    },
    {
      label: "Duplicates",
      value: s.duplicates,
      cls: s.duplicates > 0 ? "health-warn" : "health-ok",
    },
  ];

  const maxCodec = Math.max(...report.codec_analysis.map((c) => c.count), 1);
  const maxRes = Math.max(...report.resolution_stats.map((r) => r.count), 1);

  // Group issues by type
  const issueGroups = {};
  for (const issue of report.issues) {
    if (!issueGroups[issue.type]) issueGroups[issue.type] = [];
    issueGroups[issue.type].push(issue);
  }

  return html`<div class="health-page">
    <h1
      style=${{ fontSize: "1.5rem", fontWeight: 500, marginBottom: "1.5rem" }}
    >
      Library Health
    </h1>

    <div class="health-summary">
      ${cards.map(
        (c) =>
          html`<div class="health-card">
            <div class=${`health-card-value ${c.cls}`}>${c.value}</div>
            <div class="health-card-label">${c.label}</div>
          </div>`,
      )}
    </div>

    ${report.codec_analysis.length > 0 &&
    html`<h2
        style=${{ fontSize: "1.1rem", fontWeight: 500, marginBottom: ".75rem" }}
      >
        Codec Distribution
      </h2>
      <div style=${{ marginBottom: "2rem" }}>
        ${report.codec_analysis.map(
          (c) =>
            html`<div class="health-bar">
              <div
                class="health-bar-fill"
                style=${{ width: (c.count / maxCodec) * 100 + "%" }}
              ></div>
              <span class="health-bar-label">${c.codec} (${c.count})</span>
            </div>`,
        )}
      </div>`}
    ${report.resolution_stats.length > 0 &&
    html`<h2
        style=${{ fontSize: "1.1rem", fontWeight: 500, marginBottom: ".75rem" }}
      >
        Resolution Distribution
      </h2>
      <div style=${{ marginBottom: "2rem" }}>
        ${report.resolution_stats.map(
          (r) =>
            html`<div class="health-bar">
              <div
                class="health-bar-fill"
                style=${{ width: (r.count / maxRes) * 100 + "%" }}
              ></div>
              <span class="health-bar-label">${r.bucket} (${r.count})</span>
            </div>`,
        )}
      </div>`}
    ${Object.keys(issueGroups).length > 0 &&
    html`<div class="health-issues">
      <h2
        style=${{ fontSize: "1.1rem", fontWeight: 500, marginBottom: ".75rem" }}
      >
        Issues
      </h2>
      ${Object.entries(issueGroups).map(
        ([type, items]) =>
          html`<div style=${{ marginBottom: "1rem" }}>
            <h3
              style=${{
                fontSize: ".9rem",
                color: "var(--text-dim)",
                marginBottom: ".5rem",
                textTransform: "uppercase",
              }}
            >
              ${type.replace(/_/g, " ")} (${items.length})
            </h3>
            ${items.slice(0, 50).map(
              (issue) =>
                html`<div class="health-issue">
                  <span class="health-issue-type"
                    >${issue.type.replace(/_/g, " ")}</span
                  >
                  <span class="health-issue-title">${issue.title}</span>
                  <span class="health-issue-detail">${issue.detail}</span>
                </div>`,
            )}
            ${items.length > 50 &&
            html`<div
              style=${{
                padding: ".5rem .75rem",
                color: "var(--text-dim)",
                fontSize: ".85rem",
              }}
            >
              ...and ${items.length - 50} more
            </div>`}
          </div>`,
      )}
    </div>`}

    <div style=${{ marginTop: "2rem", display: "flex", gap: ".75rem" }}>
      <button class="btn-primary" onClick=${loadReport}>Refresh</button>
      ${s.orphaned_entries > 0 &&
      html`<button
        class="btn-primary"
        style=${{ background: "rgba(229,9,20,.8)" }}
        onClick=${handleCleanup}
        disabled=${cleaning}
      >
        ${cleaning ? "Cleaning..." : `Cleanup ${s.orphaned_entries} Orphaned`}
      </button>`}
    </div>
  </div>`;
}
