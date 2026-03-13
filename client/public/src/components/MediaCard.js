import { h } from "https://unpkg.com/preact@10/dist/preact.module.js";
import htm from "https://unpkg.com/htm@3?module";
import { navigate } from "../router.js";
const html = htm.bind(h);
export function MediaCard({ item }) {
  const progress =
    item.position_seconds && item.duration_seconds
      ? (item.position_seconds / item.duration_seconds) * 100
      : 0;
  const mediaId = item.media_id || item.id;
  return html`<div
    class="media-card"
    onClick=${() => navigate("/detail/" + mediaId)}
  >
    <div class="media-card-poster">
      ${item.poster_path
        ? html`<img src=${item.poster_path} alt=${item.title} loading="lazy" />`
        : html`<div class="no-poster">${item.title}</div>`}
      ${progress > 0 &&
      html`<div class="media-card-progress">
        <div
          class="media-card-progress-bar"
          style=${{ width: progress + "%" }}
        ></div>
      </div>`}
      <button
        class="media-card-play"
        onClick=${(e) => {
          e.stopPropagation();
          navigate("/play/" + mediaId);
        }}
      >
        &#9654;
      </button>
    </div>
    <div class="media-card-title">${item.title}</div>
    ${item.year && html`<div class="media-card-year">${item.year}</div>`}
  </div>`;
}
