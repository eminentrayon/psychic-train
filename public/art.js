/* ==========================================================================
   RuneDeck — vector artwork shared by the lobby and the in-game HUD.
   Inline the markup for crisp SVG, or pass it through svgUrl() for an <img>.
   ========================================================================== */

export const CARD_ICONS = {
  footmen_squad: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="fm-steel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f8ff"/><stop offset="1" stop-color="#6c83b6"/></linearGradient>
      <linearGradient id="fm-blade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#9fb4d8"/></linearGradient>
    </defs>
    <g fill="url(#fm-blade)" stroke="#1a2238" stroke-width="1" stroke-linejoin="round">
      <path d="M14 5l3 5v14h-6V10z"/><path d="M50 5l3 5v14h-6V10z"/><path d="M32 2l3.5 6v20h-7V8z"/>
    </g>
    <g fill="url(#fm-steel)" stroke="#e9c35c" stroke-width="2" stroke-linejoin="round">
      <path d="M5 22h18v12c0 7-5 11-9 13-4-2-9-6-9-13z"/>
      <path d="M41 22h18v12c0 7-5 11-9 13-4-2-9-6-9-13z"/>
      <path d="M20 28h24v15c0 9-7 14-12 17-5-3-12-8-12-17z"/>
    </g>
    <path d="M32 34v19M25 41h14" stroke="#2f6fd0" stroke-width="3.6" stroke-linecap="round"/>
    <path d="M14 27v13M50 27v13" stroke="#2f6fd0" stroke-width="2.4" stroke-linecap="round" opacity=".75"/>
  </svg>`,

  arcane_archer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="aa-bow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0b8"/><stop offset="1" stop-color="#b17a22"/></linearGradient>
      <linearGradient id="aa-arrow" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8a6bff"/><stop offset="1" stop-color="#b6fbff"/></linearGradient>
    </defs>
    <g transform="rotate(-40 32 32)">
      <path d="M26 5C53 15 53 49 26 59" fill="none" stroke="url(#aa-bow)" stroke-width="4.6" stroke-linecap="round"/>
      <path d="M26 5L14 32l12 27" fill="none" stroke="#dfe8ff" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M12 32h40" stroke="url(#aa-arrow)" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M48 24.5l15 7.5-15 7.5 4-7.5z" fill="#d6fdff" stroke="#3fd6ff" stroke-width="1" stroke-linejoin="round"/>
      <path d="M12 32l-6-4.5M12 32l-6 4.5" stroke="#b79cff" stroke-width="2.2" stroke-linecap="round"/>
    </g>
    <path d="M52 44l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3z" fill="#d6fdff"/>
    <circle cx="9" cy="24" r="1.7" fill="#b79cff"/><circle cx="30" cy="8" r="1.3" fill="#d6fdff"/>
  </svg>`,

  siege_golem: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="sg-stone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c3cbda"/><stop offset="1" stop-color="#4a5266"/></linearGradient>
      <radialGradient id="sg-core"><stop offset="0" stop-color="#fff6c2"/><stop offset=".5" stop-color="#ffb23e"/><stop offset="1" stop-color="#ff6a1a" stop-opacity="0"/></radialGradient>
    </defs>
    <g fill="url(#sg-stone)" stroke="#1d2230" stroke-width="1.6" stroke-linejoin="round">
      <path d="M3 31l4-10 10-3 6 6-1 13-8 5-9-3z"/>
      <path d="M61 31l-4-10-10-3-6 6 1 13 8 5 9-3z"/>
      <path d="M18 26l6-4h16l6 4-3 27-8 7h-6l-8-7z"/>
      <path d="M23 8l5-4h8l5 4 1 11-5 5H27l-5-5z"/>
    </g>
    <path d="M26 12.5h5v3.5h-5zM33 12.5h5v3.5h-5z" fill="#ffd45e"/>
    <circle cx="32" cy="40" r="10" fill="url(#sg-core)"/>
    <path d="M32 33l5.5 7-5.5 7-5.5-7z" fill="#fff1b0" stroke="#ff9a2e" stroke-width="1"/>
    <path d="M9 24l3 6M53 23l-2 7M21 31l3 5M43 31l-2 6M28 54l2-4" stroke="#262c3c" stroke-width="1.2" fill="none" stroke-linecap="round"/>
  </svg>`,

  fireball: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="fb-tail" x1="6" y1="5" x2="42" y2="42" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff3b1f" stop-opacity=".1"/><stop offset="1" stop-color="#ff8a1f"/></linearGradient>
      <radialGradient id="fb-core" cx=".4" cy=".38" r=".7"><stop offset="0" stop-color="#fffbe0"/><stop offset=".35" stop-color="#ffd447"/><stop offset=".7" stop-color="#ff7a1a"/><stop offset="1" stop-color="#d42312"/></radialGradient>
    </defs>
    <path d="M5 4C26 7 45 15 55 33L27 49C22 34 14 18 5 4z" fill="url(#fb-tail)"/>
    <path d="M15 13C30 16 43 22 50 34L31 45C27 34 22 22 15 13z" fill="#ffd76a" opacity=".8"/>
    <circle cx="40" cy="42" r="15" fill="url(#fb-core)" stroke="#7a1408" stroke-width="1"/>
    <circle cx="35" cy="37" r="3.2" fill="#ffffff" opacity=".75"/>
    <circle cx="10" cy="30" r="1.8" fill="#ffb347"/><circle cx="26" cy="5" r="1.5" fill="#ffd76a"/><circle cx="58" cy="14" r="1.6" fill="#ff7a1a"/>
  </svg>`,

  frost_tower: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="ft-stone" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#effbff"/><stop offset=".5" stop-color="#7fcdf2"/><stop offset="1" stop-color="#27639f"/></linearGradient>
      <linearGradient id="ft-ice" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#6fe3ff"/></linearGradient>
    </defs>
    <g stroke="#0f2f55" stroke-width="1.6" stroke-linejoin="round">
      <path d="M22 31h20l4 28H18z" fill="url(#ft-stone)"/>
      <path d="M16 21h6v4h6v-4h8v4h6v-4h6v11H16z" fill="url(#ft-stone)"/>
      <path d="M28.5 52v-9a3.5 3.5 0 017 0v9z" fill="#0d2748"/>
    </g>
    <path d="M32 1l6.5 9-6.5 10-6.5-10z" fill="url(#ft-ice)" stroke="#39c6f2" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M32 1v19" stroke="#ffffff" stroke-opacity=".8"/>
    <path d="M18 32l2 6 2-6zM28 32l1.5 5 1.5-5zM42 32l2 6 2-6z" fill="#e6faff"/>
    <g stroke="#e6faff" stroke-width="1.5" stroke-linecap="round">
      <path d="M8 9v9M4 11.2l8 4.6M12 11.2l-8 4.6"/>
      <path d="M56 38v9M52 40.2l8 4.6M60 40.2l-8 4.6"/>
    </g>
  </svg>`,

  healing_wave: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <linearGradient id="hw-plus" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4fff6"/><stop offset="1" stop-color="#3fe08a"/></linearGradient>
      <radialGradient id="hw-glow"><stop offset="0" stop-color="#8dffc1" stop-opacity=".75"/><stop offset="1" stop-color="#8dffc1" stop-opacity="0"/></radialGradient>
    </defs>
    <circle cx="32" cy="23" r="23" fill="url(#hw-glow)"/>
    <path d="M26.5 6h11v11.5H49v11H37.5V40h-11V28.5H15v-11h11.5z" fill="url(#hw-plus)" stroke="#0f7a45" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M5 49c6-8 12-8 18 0s12 8 18 0 12-8 18 0" fill="none" stroke="#7dffb8" stroke-width="3.6" stroke-linecap="round"/>
    <path d="M9 58c5-6 10-6 15 0s10 6 15 0 10-6 15 0" fill="none" stroke="#f6e2a0" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>
  </svg>`,

  unknown: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6l22 26-22 26-22-26z" fill="none" stroke="#e3b755" stroke-width="3" stroke-linejoin="round"/></svg>`,
};

export const HERO_PORTRAIT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id="ak-steel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2f6ff"/><stop offset=".55" stop-color="#8ea3cc"/><stop offset="1" stop-color="#3c4c78"/></linearGradient>
    <linearGradient id="ak-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1b8"/><stop offset="1" stop-color="#c08a25"/></linearGradient>
    <radialGradient id="ak-aura"><stop offset="0" stop-color="#58e6ff" stop-opacity=".6"/><stop offset="1" stop-color="#58e6ff" stop-opacity="0"/></radialGradient>
  </defs>
  <circle cx="32" cy="32" r="31" fill="url(#ak-aura)"/>
  <path d="M32 2l5 9-5 15-5-15z" fill="url(#ak-gold)" stroke="#6b4a12" stroke-width="1" stroke-linejoin="round"/>
  <path d="M13 34C13 17 21 10 32 10s19 7 19 24v14L41 60l-9-6-9 6-10-12z" fill="url(#ak-steel)" stroke="#1a2238" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M18 31h28l-2 7.5h-9V53h-6V38.5h-9z" fill="#050d1b"/>
  <path d="M21 33h9v3.5h-8zM34 33h9l-1 3.5h-8z" fill="#8df5ff"/>
  <path d="M32 11v19" stroke="url(#ak-gold)" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M13 34C13 17 21 10 32 10s19 7 19 24" fill="none" stroke="url(#ak-gold)" stroke-width="1.8"/>
</svg>`;

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

/** Keyed by ability id. */
export const ABILITY_ICONS = {
  slash_dash: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#1c6fc4"/><stop offset="1" stop-color="#f2ffff"/></linearGradient></defs>
    <rect width="64" height="64" fill="#0a1630"/>
    <path d="M4 56C24 52 46 36 60 6 53 38 34 57 4 56z" fill="url(#g)"/>
    <path d="M6 40C19 36 33 24 42 6 39 26 26 41 6 40z" fill="#7fe3ff" opacity=".7"/>
    <path d="M26 60c13-3 25-12 33-27-3 17-15 27-33 27z" fill="#b8f6ff" opacity=".55"/>
    <path d="M12 20h14M8 28h10" stroke="#eaffff" stroke-width="2.4" stroke-linecap="round" opacity=".8"/>
  </svg>`,

  aegis_shield: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fe6ff"/><stop offset="1" stop-color="#1a4fb8"/></linearGradient></defs>
    <rect width="64" height="64" fill="#0b1838"/>
    <circle cx="32" cy="32" r="27" fill="none" stroke="#5ad8ff" stroke-opacity=".55" stroke-width="2" stroke-dasharray="5 5"/>
    <path d="M32 9l18 6v14c0 13-8 21-18 27-10-6-18-14-18-27V15z" fill="url(#g)" stroke="#f6e2a0" stroke-width="2.6" stroke-linejoin="round"/>
    <path d="M32 17v31M22 29h20" stroke="#f6e2a0" stroke-width="3.2" stroke-linecap="round"/>
  </svg>`,

  thunder_strike: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ffcf3a"/></linearGradient></defs>
    <rect width="64" height="64" fill="#1a1140"/>
    <path d="M6 14c8-8 20-10 28-6 8-6 20-2 24 8-10-4-18-2-22 2-8-6-20-6-30-4z" fill="#6f5bd6" opacity=".8"/>
    <path d="M37 12L15 38h13l-6 22 28-33H36z" fill="url(#g)" stroke="#fff7c2" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M50 38l4 6M10 46l-5 5M52 52l5 3" stroke="#c9b8ff" stroke-width="2.4" stroke-linecap="round"/>
  </svg>`,

  divine_judgment: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f0b83a"/></linearGradient>
      <radialGradient id="h" cx=".5" cy=".2" r=".9"><stop offset="0" stop-color="#8a5a12"/><stop offset="1" stop-color="#1c1004"/></radialGradient>
    </defs>
    <rect width="64" height="64" fill="url(#h)"/>
    <path d="M32 2 8 62M32 2l24 60M32 2 20 62M32 2l12 60" stroke="#ffe08a" stroke-width="2" opacity=".45"/>
    <path d="M27 6h10v34l-5 9-5-9z" fill="url(#g)" stroke="#fff7d0" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M18 12h28v6H18z" fill="#e3b755" stroke="#7a5415" stroke-width="1"/>
    <ellipse cx="32" cy="55" rx="21" ry="5" fill="none" stroke="#fff1b8" stroke-width="2.6"/>
  </svg>`,
};

/** Keyed by item id. */
export const ITEM_ICONS = {
  blink_boots: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b8fff4"/><stop offset="1" stop-color="#0f8f8a"/></linearGradient></defs>
    <rect width="64" height="64" fill="#082a2e"/>
    <path d="M24 10h14v25l13 8c4 2 5 6 4 10H20c-2-5-1-9 3-11z" fill="url(#g)" stroke="#eafffb" stroke-width="2" stroke-linejoin="round"/>
    <path d="M20 53h35" stroke="#0a3d3b" stroke-width="3"/>
    <path d="M5 22h12M3 33h11M7 44h9" stroke="#7dffe6" stroke-width="3.2" stroke-linecap="round"/>
  </svg>`,

  lifesteal_blade: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <defs><linearGradient id="g" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e02a3a"/></linearGradient></defs>
    <rect width="64" height="64" fill="#2a0a12"/>
    <path d="M50 4c4 17-3 31-20 42l-7-7C35 27 44 16 50 4z" fill="url(#g)" stroke="#ffd0d0" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M17 36l11 11-5 5-11-11z" fill="#e3b755" stroke="#7a5415" stroke-width="1"/>
    <path d="M13 46l5 5-8 8-5-5z" fill="#8a6220"/>
    <path d="M49 38c4 6 7 10 7 13a7 7 0 01-14 0c0-3 3-7 7-13z" fill="#ff4a4a" stroke="#ffc0c0" stroke-width="1.2"/>
  </svg>`,

  power_rune: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" fill="#15101f"/>
    <path d="M32 7l19 25-19 25-19-25z" fill="none" stroke="#e3b755" stroke-width="2.6" stroke-dasharray="6 4" stroke-linejoin="round" opacity=".75"/>
    <path d="M32 21v22M25 29l7-8 7 8" fill="none" stroke="#e3b755" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>
  </svg>`,
};

/** Data URI for `<img>`. Each image is its own document, so gradient ids cannot collide. */
export function svgUrl(markup) {
  return `data:image/svg+xml,${encodeURIComponent(markup.replace(/\s+/g, ' '))}`;
}
