/* ==========================================================================
   RuneDeck — the two faction sigils, as vector artwork.
   Inline the markup for crisp SVG, or pass it through svgUrl() for an <img>.
   Card illustrations, hero portraits and ability icons are painted in paint.js.
   ========================================================================== */

export const SIGILS = {
  radiant: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">
    <defs><linearGradient id="sr-ice" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#2fa8ee"/></linearGradient></defs>
    <g fill="url(#sr-ice)" stroke="#ecfcff" stroke-width="1.2" stroke-linejoin="round">
      <path d="M14 22l6 8v16l-6 9-6-9V30z" opacity=".85"/><path d="M50 22l6 8v16l-6 9-6-9V30z" opacity=".85"/>
      <path d="M32 4l9 12v28l-9 16-9-16V16z"/>
    </g>
    <path d="M32 4v56" stroke="#ffffff" stroke-opacity=".75"/>
  </svg>`,
  dire: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">
    <defs><linearGradient id="sd-fire" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb24a"/><stop offset="1" stop-color="#c41a12"/></linearGradient></defs>
    <path d="M32 3c5 14 22 21 20 40-1 12-10 18-20 18s-19-6-20-17c-1-9 6-14 7-22 4 6 7 6 9 3-2-10 1-16 4-22z" fill="url(#sd-fire)" stroke="#ffd9a0" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M32 30c3 7 10 10 9 18-1 7-5 9-9 9s-8-2-9-8c-1-5 4-7 4-11 2 2 4 1 5-8z" fill="#ffe9a8"/>
  </svg>`,
};

/** Data URI for `<img>`. Each image is its own document, so gradient ids cannot collide. */
export function svgUrl(markup) {
  return `data:image/svg+xml,${encodeURIComponent(markup.replace(/\s+/g, ' '))}`;
}
