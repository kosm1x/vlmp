import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { get } from "../api.js";
const html = htm.bind(h);

// Server-side directory browser for picking a library folder. The server
// decides the starting point (drive list on Windows, / elsewhere); passing
// no path re-enters that root view.
export function FolderPicker({ onSelect, onCancel }) {
  const [listing, setListing] = useState(null); // { path, parent, dirs }
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  async function open(path) {
    setLoading(true);
    setError("");
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      const data = await get(`/admin/fs/dirs${qs}`);
      if (!mountedRef.current) return;
      setListing(data);
    } catch (err) {
      if (mountedRef.current)
        setError(err.message || "Could not read directory");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    open(null);
  }, []);

  function goUp() {
    // parent null at a drive root means "back to the drive list" (or the
    // POSIX root, where the button is hidden).
    open(listing?.parent || null);
  }

  const atRootList = listing && listing.path === null;

  return html`<div
    class="lum-modal-overlay"
    onClick=${(e) => {
      if (e.target === e.currentTarget) onCancel();
    }}
  >
    <div
      class="lum-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a folder"
    >
      <div class="lum-modal-title">Choose a folder</div>
      <div class="lum-modal-path" title=${listing?.path || ""}>
        ${atRootList ? "Drives" : listing?.path || "…"}
      </div>
      ${error && html`<div class="lum-modal-error">${error}</div>`}
      <div class="lum-modal-list">
        ${
          !atRootList &&
          listing &&
          html`<button class="lum-modal-entry up" onClick=${goUp}>
            ↑ Up one level
          </button>`
        }
        ${listing?.dirs.map(
          (d) =>
            html`<button
              key=${d.path}
              class="lum-modal-entry"
              onClick=${() => open(d.path)}
              title=${d.path}
            >
              ${d.name}
            </button>`,
        )}
        ${
          listing && !loading && listing.dirs.length === 0
            ? html`<div class="lum-modal-empty">No subfolders</div>`
            : null
        }
      </div>
      <div class="lum-modal-actions">
        <button class="lum-btn" onClick=${onCancel}>Cancel</button>
        <button
          class="lum-btn primary"
          disabled=${!listing || listing.path === null}
          onClick=${() => onSelect(listing.path)}
        >
          Select this folder
        </button>
      </div>
    </div>
  </div>`;
}
