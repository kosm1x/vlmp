import { h } from "https://unpkg.com/preact@10/dist/preact.module.js";
import {
  useState,
  useEffect,
} from "https://unpkg.com/preact@10/hooks/dist/hooks.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { get, post, del } from "../api.js";
import { navigate } from "../router.js";
import { MediaRow } from "./MediaRow.js";
const html = htm.bind(h);

export function MediaDetail({ id, serverId }) {
  const [media, setMedia] = useState(null);
  const [subtitles, setSubtitles] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
  const [error, setError] = useState("");
  const [preference, setPreference] = useState(null);
  const [similar, setSimilar] = useState([]);

  const isRemote = !!serverId;
  useEffect(() => {
    let cancelled = false;
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
          if (!cancelled) setSubtitles(d);
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
    } catch (e) {
      alert(e.message);
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
    ${media.backdrop_path &&
    html`<div
      class="detail-backdrop"
      style=${{ backgroundImage: "url(" + media.backdrop_path + ")" }}
    ></div>`}
    <div class="detail-content">
      <div class="detail-poster">
        ${media.poster_path
          ? html`<img src=${media.poster_path} alt=${media.title} />`
          : html`<div class="no-poster detail-no-poster">${media.title}</div>`}
      </div>
      <div class="detail-info">
        <h1 class="detail-title">${media.title}</h1>
        <div class="detail-meta">
          ${media.year && html`<span class="detail-year">${media.year}</span>`}
          ${rating && html`<span class="detail-rating">★ ${rating}</span>`}
          ${media.duration &&
          html`<span class="detail-duration"
            >${Math.floor(media.duration / 60)} min</span
          >`}
        </div>
        ${genres.length > 0 &&
        html`<div class="detail-genres">
          ${genres.map((g) => html`<span class="detail-genre">${g}</span>`)}
        </div>`}
        ${media.description &&
        html`<p class="detail-description">${media.description}</p>`}
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
          ${!isRemote &&
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
            </button>`}
        </div>
        ${showPlaylistPicker &&
        html`<div class="detail-playlist-picker">
          ${playlists.length === 0
            ? html`<div class="detail-picker-empty">No playlists yet</div>`
            : playlists.map(
                (p) =>
                  html`<div
                    class="detail-picker-item"
                    onClick=${() => addToPlaylist(p.id)}
                  >
                    ${p.name}
                  </div>`,
              )}
        </div>`}
        ${subtitles.length > 0 &&
        html`<div class="detail-subtitles">
          <h3>Subtitles</h3>
          ${subtitles.map(
            (s) =>
              html`<span class="detail-subtitle-tag"
                >${s.label || s.language || "Unknown"}</span
              >`,
          )}
        </div>`}
      </div>
    </div>
    ${!isRemote &&
    similar.length > 0 &&
    html`<div
      style=${{ padding: "0 2rem 2rem", maxWidth: "1100px", margin: "0 auto" }}
    >
      <${MediaRow} label="Similar" items=${similar} />
    </div>`}
  </div>`;
}
