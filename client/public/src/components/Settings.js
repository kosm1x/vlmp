import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { get, post, del, getUserRole, getUserId } from "../api.js";
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
  const [users, setUsers] = useState(null);
  const [usersError, setUsersError] = useState("");
  const [userFormError, setUserFormError] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("user");
  const [userPending, setUserPending] = useState(false);
  const [busyUser, setBusyUser] = useState(null);
  const pollTimer = useRef(null);
  const mountedRef = useRef(true);
  const selfId = getUserId();

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

  async function loadUsers() {
    try {
      const data = await get("/admin/users");
      if (!mountedRef.current) return;
      setUsers(data);
      setUsersError("");
    } catch (err) {
      if (mountedRef.current)
        setUsersError(err.message || "Failed to load users");
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    load();
    loadUsers();
    return () => {
      mountedRef.current = false;
      clearTimeout(pollTimer.current);
    };
  }, []);

  async function addUser(e) {
    e.preventDefault();
    if (!newUsername.trim() || !newPassword || userPending) return;
    setUserPending(true);
    setUserFormError("");
    try {
      await post("/admin/users", {
        username: newUsername.trim(),
        password: newPassword,
        role: newRole,
      });
      if (!mountedRef.current) return;
      setNewUsername("");
      setNewPassword("");
      setNewRole("user");
      await loadUsers();
    } catch (err) {
      if (mountedRef.current)
        setUserFormError(err.message || "Failed to create user");
    } finally {
      if (mountedRef.current) setUserPending(false);
    }
  }

  async function removeUser(user) {
    if (
      !confirm(
        `Remove ${user.username}? Their access ends immediately and their watch history and playlists are deleted.`,
      )
    )
      return;
    setBusyUser(user.id);
    try {
      await del(`/admin/users/${user.id}`);
      if (!mountedRef.current) return;
      await loadUsers();
    } catch (err) {
      if (mountedRef.current)
        setUsersError(err.message || "Failed to remove user");
    } finally {
      if (mountedRef.current) setBusyUser(null);
    }
  }

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
        html`<table class="settings-table">
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

    <section class="settings-section" aria-labelledby="users-label">
      <div class="settings-label" id="users-label">Users</div>
      ${
        users === null &&
        !usersError &&
        html`<div class="loading">Loading...</div>`
      }
      ${
        usersError &&
        html`<div class="settings-error" role="alert">${usersError}</div>`
      }
      ${
        users !== null &&
        html`<table class="settings-table">
          <thead>
            <tr>
              <th scope="col">Username</th>
              <th scope="col">Role</th>
              <th scope="col">Created</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            ${users.map(
              (u) =>
                html`<tr key=${u.id}>
                  <td data-label="Username">
                    ${u.username}${u.id === selfId ? " (you)" : ""}
                  </td>
                  <td class="folder-category" data-label="Role">${u.role}</td>
                  <td class="folder-category" data-label="Created">
                    ${new Date(u.created_at * 1000).toLocaleDateString()}
                  </td>
                  <td>
                    <div class="folder-actions">
                      <button
                        class="lum-btn danger"
                        onClick=${() => removeUser(u)}
                        disabled=${u.id === selfId || busyUser === u.id}
                        title=${
                          u.id === selfId
                            ? "You cannot delete your own account"
                            : undefined
                        }
                        aria-label=${`Remove user ${u.username}`}
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

    <section class="settings-section" aria-labelledby="add-user-label">
      <div class="settings-label" id="add-user-label">Add User</div>
      <form class="settings-form" onSubmit=${addUser}>
        <div class="settings-field grow">
          <label for="new-username">Username</label>
          <input
            id="new-username"
            type="text"
            autocomplete="off"
            value=${newUsername}
            onInput=${(e) => setNewUsername(e.target.value)}
            minlength="3"
            required
          />
        </div>
        <div class="settings-field grow">
          <label for="new-password">Password</label>
          <input
            id="new-password"
            type="password"
            autocomplete="new-password"
            value=${newPassword}
            onInput=${(e) => setNewPassword(e.target.value)}
            minlength="8"
            required
          />
        </div>
        <div class="settings-field">
          <label for="new-role">Role</label>
          <select
            id="new-role"
            value=${newRole}
            onChange=${(e) => setNewRole(e.target.value)}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button class="lum-btn" type="submit" disabled=${userPending}>
          ${userPending ? "Creating…" : "Add User"}
        </button>
      </form>
      ${
        userFormError &&
        html`<div class="settings-error" role="alert">${userFormError}</div>`
      }
      <p class="settings-note">
        Registration is closed — accounts you create here are the only way in.
        For time-limited outside sharing, use a guest pass from a title's detail
        page.
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
