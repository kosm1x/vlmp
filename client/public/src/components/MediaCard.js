import { h } from "preact";
import htm from "htm";
import { navigate } from "../router.js";
import { ThumbImg } from "./ThumbImg.js";
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
      ${
        item.poster_path
          ? html`<img
              src=${item.poster_path}
              alt=${item.title}
              loading="lazy"
            />`
          : html`<${ThumbImg} mediaId=${mediaId} title=${item.title} />`
      }
      ${
        progress > 0 &&
        html`<div class="media-card-progress">
          <div
            class="media-card-progress-bar"
            style=${{ width: progress + "%" }}
          ></div>
        </div>`
      }
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
