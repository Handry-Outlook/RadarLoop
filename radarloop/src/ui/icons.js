/**
 * The interface icon set.
 *
 * Everything used to be a text glyph — `⚡`, `🗺`, `🌡`, `◍`, `≋` and so on. That
 * is a rendering lottery: a few of those characters have an emoji presentation
 * (the lightning bolt came out yellow while its neighbours were monochrome),
 * several have no glyph at all in some system fonts and fall back to a box, and
 * their weights and optical sizes never matched each other because they come
 * from whatever fonts happen to be installed.
 *
 * These are drawn instead: one 24×24 grid, one stroke weight, `currentColor`
 * throughout, so they inherit the button's colour and every state that goes with
 * it. Paths are deliberately simple — at 17px on a phone, detail is noise.
 */

const SVG = 'http://www.w3.org/2000/svg';

/** Path data, on a 24×24 grid with a 1.6px stroke. */
const PATHS = {
  layers: ['M12 3 3 8l9 5 9-5-9-5Z', 'M3 13l9 5 9-5', 'M3 17.5l9 5 9-5'],
  basemap: ['M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 7 9 4Z', 'M9 4v13', 'M15 7v12.5'],
  radar: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0', 'M12 12h9'],
  pressure: ['M3 8h13a3 3 0 1 0-3-3', 'M3 13h16a3 3 0 1 1-3 3', 'M3 18h9a2.5 2.5 0 1 1-2.5 2.5'],
  lightning: ['M13 2 4 14h6l-1 8 9-12h-6l1-8Z'],
  severe: ['M12 3 2 20h20L12 3Z', 'M12 10v5', 'M12 18h.01'],
  observations: ['M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z', 'M12 9v6'],
  outlook: ['M12 2 3 12l9 10 9-10-9-10Z', 'M12 8l-4 4 4 4 4-4-4-4Z'],
  tools: ['M15.5 3.5 20.5 8.5', 'M3 21l1.5-5L16 4.5a2.1 2.1 0 0 1 3 3L7.5 19 3 21Z'],
  settings: [
    'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 15h-.2a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z',
  ],

  /* --- top bar --- */
  locate: ['M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3'],
  legend: ['M4 6h16', 'M4 12h16', 'M4 18h16', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  theme: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 3v18a9 9 0 0 0 0-18Z'],
  help: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M9.5 9a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.4v.6', 'M12 17h.01'],
  fullscreen: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  cube: ['M12 2 3 7v10l9 5 9-5V7l-9-5Z', 'M3 7l9 5 9-5', 'M12 12v10'],
  search: ['M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0', 'M16.2 16.2 21 21'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
};

/**
 * Builds one icon.
 *
 * `aria-hidden` because every caller is a button that already carries its own
 * label — announcing the drawing as well would just repeat it.
 */
export function icon(name, { size = 20, stroke = 1.6 } = {}) {
  const paths = PATHS[name];
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');

  for (const d of paths || []) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export const hasIcon = (name) => Object.hasOwn(PATHS, name);

/** Replaces a button's text glyph with the drawn icon, keeping its label. */
export function applyIcon(element, name, options) {
  if (!element || !hasIcon(name)) return;
  element.replaceChildren(icon(name, options));
}
