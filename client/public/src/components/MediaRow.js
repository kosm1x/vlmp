import { h } from 'preact';
import htm from 'htm';
import { MediaCard } from './MediaCard.js';
const html = htm.bind(h);
export function MediaRow({ label, items }) {
  return html`<div class="media-row"><h2>${label}</h2><div class="media-row-items">${items.map(i => html`<${MediaCard} key=${i.id} item=${i} />`)}</div></div>`;
}
