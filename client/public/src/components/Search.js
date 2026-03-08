import { h } from 'https://unpkg.com/preact@10/dist/preact.module.js';
import { useState, useEffect } from 'https://unpkg.com/preact@10/hooks/dist/hooks.module.js';
import htm from 'https://unpkg.com/htm@3?module';
import { get } from '../api.js';
import { MediaCard } from './MediaCard.js';
const html = htm.bind(h);
export function Search({ query }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!query) return;
    setLoading(true);
    get('/library/browse?search=' + encodeURIComponent(query) + '&limit=50').then(d => setResults(d.items || [])).catch(() => setResults([])).finally(() => setLoading(false));
  }, [query]);
  if (!query) return html`<div class="browse"><div class="empty"><h2>Type to search</h2></div></div>`;
  if (loading) return html`<div class="browse"><div class="loading">Searching...</div></div>`;
  return html`<div class="browse"><div class="media-row"><h2>Results for "${query}"</h2><div class="media-row-items" style=${{ flexWrap: 'wrap' }}>${results.length ? results.map(i => html`<${MediaCard} key=${i.id} item=${i} />`) : html`<div class="empty">No results</div>`}</div></div></div>`;
}
