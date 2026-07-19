import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { get, post, del, getUserRole } from "../api.js";
const html = htm.bind(h);

const CATEGORIES = [
  "movies",
  "tv",
  "documentaries",
  "doc_series",
  "education",
  "other",
];

export function Settings() {
  const [folders, setFolders] = useState(null);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [path, setPath] = useState("");
  const [category, setCategory] = useState("movies");
  const [pending, setPending] = useState(false);
  const [busyFolder, setBusyFolder] = useState(null);
  const pollTimer = useRef(null);
  const mountedRef = useRef(true);

  // Every setState below an await must check mountedRef — a resolve after
  // navigation would otherwise update an unmounted component, and the poll
  // loop would reschedule itself forever.
  async function load() {
    try {
      const data = await get("/admin/folders");
      if (!mountedRef.current) return null;
      setFolders(data);
      setError("");
      return data;
    } catch (err) {
      if (mountedRef.current) setError(err.message || "Failed to load folders");
      return null;
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
      clearTimeout(pollTimer.current);
    };
  }, []);

  // While any folder is scanning, refresh until every scan settles.
  function pollWhileScanning(data) {
    if (!mountedRef.current) return;
    if (!data || !data.some((f) => f.scan_status === "scanning")) return;
    clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async () => {
      pollWhileScanning(await load());
    }, 3000);
  }

  async function addFolder(e) {
    e.preventDefault();
    if (!path.trim() || pending) return;
    setPending(true);
    setFormError("");
    try {
      await post("/admin/folders", { path: path.trim(), category });
      if (!mountedRef.current) return;
      setPath("");
      await load();
    } catch (err) {
      if (mountedRef.current)
        setFormError(err.message || "Failed to add folder");
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  async function removeFolder(folder) {
    if (
      !confirm(
        `Remove "${folder.path}" and all its library entries? Media files on disk are not touched.`,
      )
    )
      return;
    setBusyFolder(folder.id);
    try {
      await del(`/admin/folders/${folder.id}`);
      await load();
    } catch (err) {
      if (mountedRef.current)
        setError(err.message || "Failed to remove folder");
    } finally {
      if (mountedRef.current) setBusyFolder(null);
    }
  }

  function scanFolder(folder) {
    // The scan endpoint holds the request open for the whole scan — fire it,
    // flip the row to "scanning" locally, and let polling track completion.
    // A rejected POST (e.g. proxy idle-timeout on a long scan) is not by
    // itself a failure: re-check and only surface an error if the folder
    // didn't actually reach a healthy state.
    post(`/admin/folders/${folder.id}/scan`, {})
      .then(() => load())
      .catch(async () => {
        const data = await load();
        if (!mountedRef.current) return;
        const current = data?.find((f) => f.id === folder.id);
        if (!current || current.scan_status === "error")
          setError(`Scan failed for ${folder.path}`);
      });
    const optimistic = folders.map((f) =>
      f.id === folder.id ? { ...f, scan_status: "scanning" } : f,
    );
    setFolders(optimistic);
    pollWhileScanning(optimistic);
  }

  if (getUserRole() !== "admin")
    return html`<div class="settings-page">
      <h1 class="settings-title">Settings</h1>
      <p class="settings-sub">Administrator access required.</p>
    </div>`;

  return html`<div class="settings-page">
    <h1 class="settings-title">Server Settings</h1>
    <p class="settings-sub">
      Library folders, scanning, and server administration.
    </p>

    <section class="settings-section" aria-labelledby="folders-label">
      <div class="settings-label" id="folders-label">Library Folders</div>
      ${folders === null && !error && html`<div class="loading">Loading...</div>`}
      ${error && html`<div class="settings-error" role="alert">${error}</div>`}
      ${
        folders !== null &&
        folders.length === 0 &&
        html`<div class="settings-empty">
          No library folders yet. Add the path to a folder of media files below
          — it will be scanned and appear on Home.
        </div>`
      }
      ${
        folders !== null &&
        folders.length > 0 &&
        html`<table class="folder-table">
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Category</th>
              <th scope="col">Status</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${folders.map(
              (f) =>
                html`<tr key=${f.id}>
                  <td class="folder-path" data-label="Path">${f.path}</td>
                  <td class="folder-category" data-label="Category">
                    ${f.category.replace("_", " ")}
                  </td>
                  <td data-label="Status">
                    <span class="scan-status ${f.scan_status || "pending"}"
                      >${f.scan_status || "pending"}</span
                    >
                  </td>
                  <td>
                    <div class="folder-actions">
                      <button
                        class="lum-btn"
                        onClick=${() => scanFolder(f)}
                        disabled=${
                          f.scan_status === "scanning" || busyFolder === f.id
                        }
                        aria-label=${`Scan ${f.path}`}
                      >
                        ${f.scan_status === "scanning" ? "Scanning…" : "Scan"}
                      </button>
                      <button
                        class="lum-btn danger"
                        onClick=${() => removeFolder(f)}
                        disabled=${
                          busyFolder === f.id || f.scan_status === "scanning"
                        }
                        aria-label=${`Remove ${f.path}`}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>`,
            )}
          </tbody>
        </table>`
      }
    </section>

    <section class="settings-section" aria-labelledby="add-label">
      <div class="settings-label" id="add-label">Add Folder</div>
      <form class="settings-form" onSubmit=${addFolder}>
        <div class="settings-field grow">
          <label for="folder-path">Absolute path on the server</label>
          <input
            id="folder-path"
            type="text"
            placeholder="/mnt/media/movies"
            value=${path}
            onInput=${(e) => setPath(e.target.value)}
            required
          />
        </div>
        <div class="settings-field">
          <label for="folder-category">Category</label>
          <select
            id="folder-category"
            value=${category}
            onChange=${(e) => setCategory(e.target.value)}
          >
            ${CATEGORIES.map(
              (c) => html`<option value=${c}>${c.replace("_", " ")}</option>`,
            )}
          </select>
        </div>
        <button class="lum-btn" type="submit" disabled=${pending}>
          ${pending ? "Adding…" : "Add Folder"}
        </button>
      </form>
      ${
        formError &&
        html`<div class="settings-error" role="alert">${formError}</div>`
      }
      <p class="settings-note">
        A scan starts from the folder row after adding. Large libraries scan in
        the background — the status column updates as it progresses.
      </p>
    </section>

    <section class="settings-section" aria-labelledby="tools-label">
      <div class="settings-label" id="tools-label">Administration</div>
      <div class="settings-links">
        <a class="lum-btn" href="#/health">Library Health</a>
        <a class="lum-btn" href="#/servers">Federated Servers</a>
      </div>
    </section>
  </div>`;
}
