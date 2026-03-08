import { h } from 'https://unpkg.com/preact@10/dist/preact.module.js';
import htm from 'https://unpkg.com/htm@3?module';
import { MediaCard } from './MediaCard.js';
const html = htm.bind(h);
export function MediaRow({ label, items }) {
  return html`<div class="media-row"><h2>${label}</h2><div class="media-row-items">${items.map(i => html`<${MediaCard} key=${i.id} item=${i} />`)}</div></div>`;
}
