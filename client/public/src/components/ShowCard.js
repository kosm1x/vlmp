import { h } from "preact";
import htm from "htm";
import { navigate } from "../router.js";
import { ThumbImg } from "./ThumbImg.js";
const html = htm.bind(h);

// Poster card for a series — same layout as MediaCard but navigates to the
// show page and shows season/episode counts instead of a year. Falls back to
// the first episode's frame-grab when the show has no TMDb poster.
export function ShowCard({ show }) {
  return html`<div
    class="media-card"
    onClick=${() => navigate("/show/" + show.id)}
  >
    <div class="media-card-poster">
      ${
        show.poster_path
          ? html`<img
              src=${show.poster_path}
              alt=${show.title}
              loading="lazy"
            />`
          : show.first_media_id
            ? html`<${ThumbImg}
                mediaId=${show.first_media_id}
                title=${show.title}
              />`
            : html`<div class="no-poster">${show.title}</div>`
      }
      <div class="show-card-badge">
        ${
          show.season_count > 1
            ? `${show.season_count} seasons`
            : `${show.episode_count} ep${show.episode_count === 1 ? "" : "s"}`
        }
      </div>
    </div>
    <div class="media-card-title">${show.title}</div>
    <div class="media-card-year">
      ${show.episode_count} episode${show.episode_count === 1 ? "" : "s"}
    </div>
  </div>`;
}
