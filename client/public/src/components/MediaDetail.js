import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { get, post, del } from "../api.js";
import { navigate } from "../router.js";
import { ThumbImg } from "./ThumbImg.js";
import { MediaRow } from "./MediaRow.js";
import { invalidateLibraryCache } from "./Browse.js";
const html = htm.bind(h);

export function MediaDetail({ id, serverId }) {
  const [media, setMedia] = useState(null);
  const [subtitles, setSubtitles] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
  const [error, setError] = useState("");
  const [preference, setPreference] = useState(null);
  const [similar, setSimilar] = useState([]);
  const [subsLoaded, setSubsLoaded] = useState(false);
  const [osOpen, setOsOpen] = useState(false);
  const [osLangs, setOsLangs] = useState("en,es");
  const [osResults, setOsResults] = useState(null);
  const [osBusy, setOsBusy] = useState(false);
  const [osApplying, setOsApplying] = useState(null);
  const [osError, setOsError] = useState("");
  const [osNotice, setOsNotice] = useState("");

  const isRemote = !!serverId;
  useEffect(() => {
    let cancelled = false;
    // This instance is REUSED across navigations (similar-titles links) — any
    // OpenSubtitles state left over would apply title A's file_id to title B,
    // and stale media/similar would render title A's page under B's id.
    setMedia(null);
    setSimilar([]);
    setPreference(null);
    setError("");
    setSubtitles([]);
    setSubsLoaded(false);
    setOsOpen(false);
    setOsResults(null);
    setOsApplying(null);
    setOsError("");
    setOsNotice("");
    const mediaUrl = isRemote
      ? `/federation/servers/${serverId}/media/${id}`
      : `/library/${id}`;
    get(mediaUrl)
      .then((d) => {
        if (!cancelled) setMedia(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    if (!isRemote) {
      get(`/subtitles/${id}`)
        .then((d) => {
          if (cancelled) return;
          setSubtitles(d);
          setSubsLoaded(true);
        })
        .catch(() => {});
      get("/playlists")
        .then((d) => {
          if (!cancelled) setPlaylists(d);
        })
        .catch(() => {});
      get("/preferences")
        .then((prefs) => {
          if (cancelled) return;
          const match = prefs.find((p) => p.media_id === parseInt(id, 10));
          if (match) setPreference(match.action);
          else setPreference(null);
        })
        .catch(() => {});
      get(`/recommendations/similar/${id}?limit=10`)
        .then((d) => {
          if (!cancelled) setSimilar(d.items || []);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [id, serverId]);

  async function togglePreference(action) {
    try {
      if (preference === action) {
        await del(`/preferences/${id}`);
        setPreference(null);
      } else {
        await post(`/preferences/${id}`, { action });
        setPreference(action);
      }
      // The cached category grids carry a per-item `liked` flag that "Liked
      // first" sorts on — this like/unlike just made them stale.
      invalidateLibraryCache();
    } catch (e) {
      alert(e.message);
    }
  }

  async function searchOpenSubtitles() {
    setOsBusy(true);
    setOsError("");
    setOsNotice("");
    setOsResults(null);
    try {
      const d = await get(
        `/subtitles/${id}/opensubtitles/search?languages=${encodeURIComponent(osLangs)}`,
      );
      setOsResults(d.results || []);
    } catch (e) {
      setOsError(e.message || "Search failed");
    } finally {
      setOsBusy(false);
    }
  }

  async function applyOpenSubtitle(result) {
    setOsApplying(result.file_id);
    setOsError("");
    try {
      const d = await post(`/subtitles/${id}/opensubtitles/apply`, {
        file_id: result.file_id,
        language: result.language,
      });
      const subs = await get(`/subtitles/${id}`);
      setSubtitles(subs);
      setOsNotice(
        `Applied ${result.language.toUpperCase()} subtitles — available on next play${
          d.remaining != null ? ` (${d.remaining} downloads left today)` : ""
        }`,
      );
      setOsResults(null);
    } catch (e) {
      setOsError(e.message || "Failed to apply subtitle");
    } finally {
      setOsApplying(null);
    }
  }

  async function addToPlaylist(playlistId) {
    try {
      await post(`/playlists/${playlistId}/items`, {
        media_id: parseInt(id, 10),
      });
      setShowPlaylistPicker(false);
    } catch (e) {
      alert(e.message);
    }
  }

  if (error)
    return html`<div class="detail-page">
      <div class="detail-error">${error}</div>
    </div>`;
  if (!media)
    return html`<div class="detail-page">
      <div class="loading">Loading...</div>
    </div>`;

  const genres = media.genres ? media.genres.split(", ") : [];
  const rating = media.rating ? media.rating.toFixed(1) : null;

  return html`<div class="detail-page">
    ${
      media.backdrop_path &&
      html`<div
        class="detail-backdrop"
        style=${{ backgroundImage: "url(" + media.backdrop_path + ")" }}
      ></div>`
    }
    <div class="detail-content">
      <div class="detail-poster">
        ${
          media.poster_path
            ? html`<img src=${media.poster_path} alt=${media.title} />`
            : html`<${ThumbImg} mediaId=${media.id} title=${media.title} />`
        }
      </div>
      <div class="detail-info">
        <h1 class="detail-title">${media.title}</h1>
        <div class="detail-meta">
          ${media.year && html`<span class="detail-year">${media.year}</span>`}
          ${rating && html`<span class="detail-rating">★ ${rating}</span>`}
          ${
            media.duration &&
            html`<span class="detail-duration"
              >${Math.floor(media.duration / 60)} min</span
            >`
          }
        </div>
        ${
          genres.length > 0 &&
          html`<div class="detail-genres">
            ${genres.map((g) => html`<span class="detail-genre">${g}</span>`)}
          </div>`
        }
        ${
          media.description &&
          html`<p class="detail-description">${media.description}</p>`
        }
        <div class="detail-actions">
          <button
            class="detail-play-btn"
            onClick=${() =>
              navigate(
                isRemote ? "/play/fed/" + serverId + "/" + id : "/play/" + id,
              )}
          >
            Play
          </button>
          <button
            class="detail-btn"
            onClick=${() => setShowPlaylistPicker(!showPlaylistPicker)}
          >
            + Playlist
          </button>
          ${
            !isRemote &&
            html`<button
                class=${`detail-btn${preference === "like" ? " active" : ""}`}
                onClick=${() => togglePreference("like")}
              >
                Like
              </button>
              <button
                class=${`detail-btn${preference === "dislike" ? " active" : ""}`}
                onClick=${() => togglePreference("dislike")}
              >
                Dislike
              </button>`
          }
        </div>
        ${
          !isRemote &&
          subsLoaded &&
          html`<div class="detail-cc-row">
            <span
              class=${`detail-cc-chip${subtitles.length === 0 ? " none" : ""}`}
            >
              ${
                subtitles.length > 0
                  ? `Subtitles: ${[
                      ...new Set(
                        subtitles.map((s) =>
                          (s.language || s.label || "?").toUpperCase(),
                        ),
                      ),
                    ].join(", ")}`
                  : "No subtitles"
              }
            </span>
            <button
              class="detail-btn detail-cc-btn"
              onClick=${() => {
                setOsOpen(!osOpen);
                setOsError("");
                setOsNotice("");
              }}
            >
              ${osOpen ? "Close search" : "Search OpenSubtitles"}
            </button>
          </div>`
        }
        ${
          !isRemote &&
          osOpen &&
          html`<div class="detail-os-panel">
            <div class="detail-os-controls">
              <input
                type="text"
                value=${osLangs}
                onInput=${(e) => setOsLangs(e.target.value)}
                placeholder="en,es"
                aria-label="Subtitle languages (comma-separated codes)"
              />
              <button
                class="lum-btn"
                onClick=${searchOpenSubtitles}
                disabled=${osBusy}
              >
                ${osBusy ? "Searching…" : "Search"}
              </button>
            </div>
            ${osError && html`<div class="detail-os-error">${osError}</div>`}
            ${osNotice && html`<div class="detail-os-notice">${osNotice}</div>`}
            ${
              osResults !== null &&
              osResults.length === 0 &&
              html`<div class="detail-os-empty">
                No results — try other languages or check the title match.
              </div>`
            }
            ${
              osResults !== null &&
              osResults.length > 0 &&
              html`<div class="detail-os-results">
                ${osResults.map(
                  (r) =>
                    html`<div class="detail-os-result" key=${r.file_id}>
                      <span class="detail-os-lang"
                        >${r.language.toUpperCase()}</span
                      >
                      <span class="detail-os-name"
                        >${r.release || r.file_name}${
                          r.hearing_impaired ? " · HI" : ""
                        }</span
                      >
                      <span class="detail-os-downloads"
                        >${r.download_count}
                        ↓${r.from_trusted ? " · trusted" : ""}</span
                      >
                      <button
                        class="lum-btn"
                        disabled=${osApplying !== null}
                        onClick=${() => applyOpenSubtitle(r)}
                      >
                        ${osApplying === r.file_id ? "Applying…" : "Apply"}
                      </button>
                    </div>`,
                )}
              </div>`
            }
          </div>`
        }
        ${
          showPlaylistPicker &&
          html`<div class="detail-playlist-picker">
            ${
              playlists.length === 0
                ? html`<div class="detail-picker-empty">No playlists yet</div>`
                : playlists.map(
                    (p) =>
                      html`<div
                        class="detail-picker-item"
                        onClick=${() => addToPlaylist(p.id)}
                      >
                        ${p.name}
                      </div>`,
                  )
            }
          </div>`
        }
      </div>
    </div>
    ${
      !isRemote &&
      similar.length > 0 &&
      html`<div
        style=${{ padding: "0 2rem 2rem", maxWidth: "1100px", margin: "0 auto" }}
      >
        <${MediaRow} label="Similar" items=${similar} />
      </div>`
    }
  </div>`;
}
