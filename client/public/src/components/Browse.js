import { h } from 'https://unpkg.com/preact@10/dist/preact.module.js';
import { useState, useEffect } from 'https://unpkg.com/preact@10/hooks/dist/hooks.module.js';
import htm from 'https://unpkg.com/htm@3?module';
import { get } from '../api.js';
import { MediaRow } from './MediaRow.js';
const html = htm.bind(h);
const CATS = [
  { key: 'continue', label: 'Continue Watching', endpoint: '/progress/continue' },
  { key: 'recent', label: 'Recently Added', endpoint: '/library/recent?limit=20' },
  { key: 'movies', label: 'Movies', endpoint: '/library/browse?category=movies&limit=20' },
  { key: 'tv', label: 'TV Shows', endpoint: '/library/browse?category=tv&limit=20' },
  { key: 'documentaries', label: 'Documentaries', endpoint: '/library/browse?category=documentaries&limit=20' },
  { key: 'education', label: 'Education & Training', endpoint: '/library/browse?category=education&limit=20' },
  { key: 'other', label: 'Other', endpoint: '/library/browse?category=other&limit=20' },
];
export function Browse({ category }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    const cats = category ? CATS.filter(c => c.key === category) : CATS;
    Promise.all(cats.map(async (cat) => { try { const d = await get(cat.endpoint); return { ...cat, items: Array.isArray(d) ? d : (d.items || []) }; } catch { return { ...cat, items: [] }; } }))
      .then(r => { setRows(r.filter(x => x.items.length > 0)); setLoading(false); });
  }, [category]);
  if (loading) return html`<div class="browse"><div class="loading">Loading...</div></div>`;
  if (!rows.length) return html`<div class="browse"><div class="empty"><h2>No media found</h2><p>Add library folders in settings to get started.</p></div></div>`;
  return html`<div class="browse">${rows.map(r => html`<${MediaRow} key=${r.key} label=${r.label} items=${r.items} />`)}</div>`;
}
