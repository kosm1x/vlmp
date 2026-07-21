import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { get } from "../api.js";
import { navigate } from "../router.js";
import { ThumbImg } from "./ThumbImg.js";
const html = htm.bind(h);

function fmtDuration(seconds) {
  if (!seconds) return "";
  return `${Math.round(seconds / 60)} min`;
}

export function ShowDetail({ id }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [openSeason, setOpenSeason] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    get(`/library/shows/${id}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        if (d.seasons.length > 0) setOpenSeason(d.seasons[0].season_number);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error)
    return html`<div class="detail-page">
      <div class="detail-error">${error}</div>
    </div>`;
  if (!data)
    return html`<div class="detail-page">
      <div class="loading">Loading...</div>
    </div>`;

  const { show, seasons } = data;
  const firstEpisode = seasons[0]?.episodes[0];
  const episodeTotal = seasons.reduce((n, s) => n + s.episodes.length, 0);

  return html`<div class="detail-page">
    ${
      show.backdrop_path &&
      html`<div
        class="detail-backdrop"
        style=${{ backgroundImage: "url(" + show.backdrop_path + ")" }}
      ></div>`
    }
    <div class="detail-content">
      <div class="detail-poster">
        ${
          show.poster_path
            ? html`<img src=${show.poster_path} alt=${show.title} />`
            : firstEpisode
              ? html`<${ThumbImg}
                  mediaId=${firstEpisode.media_id}
                  title=${show.title}
                />`
              : html`<div class="detail-no-poster">${show.title}</div>`
        }
      </div>
      <div class="detail-info">
        <h1 class="detail-title">${show.title}</h1>
        <div class="detail-meta">
          ${show.year && html`<span class="detail-year">${show.year}</span>`}
          <span
            >${seasons.length} season${seasons.length === 1 ? "" : "s"} ·
            ${episodeTotal} episode${episodeTotal === 1 ? "" : "s"}</span
          >
        </div>
        ${
          show.description &&
          html`<p class="detail-description">${show.description}</p>`
        }
        ${
          firstEpisode &&
          html`<div class="detail-actions">
            <button
              class="detail-play-btn"
              onClick=${() => navigate("/play/" + firstEpisode.media_id)}
            >
              Play S${seasons[0].season_number} ·
              E${firstEpisode.episode_number}
            </button>
          </div>`
        }
        <div class="show-seasons">
          ${seasons.map(
            (s) =>
              html`<div class="show-season" key=${s.id}>
                <button
                  class="show-season-header"
                  onClick=${() =>
                  setOpenSeason(
                    openSeason === s.season_number ? null : s.season_number,
                  )}
                  aria-expanded=${openSeason === s.season_number}
                >
                  <span
                    >Season ${s.season_number}
                    <span class="show-season-count"
                      >${s.episodes.length}
                      episode${s.episodes.length === 1 ? "" : "s"}</span
                    ></span
                  >
                  <span class="show-season-chevron"
                    >${openSeason === s.season_number ? "▾" : "▸"}</span
                  >
                </button>
                ${
                openSeason === s.season_number &&
                html`<div class="show-episodes">
                  ${s.episodes.map(
                    (e) =>
                      html`<div
                        class="show-episode"
                        key=${e.id}
                        onClick=${() => navigate("/detail/" + e.media_id)}
                      >
                        <span class="show-episode-num"
                          >${e.episode_number}</span
                        >
                        <span class="show-episode-title"
                          >${e.title || `Episode ${e.episode_number}`}</span
                        >
                        <span class="show-episode-duration"
                          >${fmtDuration(e.duration)}</span
                        >
                        <button
                          class="lum-btn"
                          onClick=${(ev) => {
                          ev.stopPropagation();
                          navigate("/play/" + e.media_id);
                        }}
                          aria-label=${`Play episode ${e.episode_number}`}
                        >
                          ▶ Play
                        </button>
                      </div>`,
                  )}
                </div>`
              }
              </div>`,
          )}
        </div>
      </div>
    </div>
  </div>`;
}
