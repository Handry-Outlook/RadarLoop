/**
 * Publishes the height of the docked chrome as CSS custom properties.
 *
 * On a phone the rail, the timeline and the panel sheet are all docked to the
 * bottom of the screen. They were each pinned to `bottom: 0` and layered by
 * z-index, so the panel — the lowest of the three — came up underneath the
 * timeline and the icon rail and was largely unusable.
 *
 * Their heights cannot be hard-coded: the timeline wraps to two or three rows
 * depending on width, the rail grows with the safe-area inset, and both change
 * on rotation. So they are measured and republished whenever they change, and
 * the stylesheet stacks the three against each other rather than overlapping
 * them.
 *
 * Nothing here is mobile-specific; only the mobile rules consume the values.
 */

const TRACKED = [
  ['#timeline', '--timeline-dock'],
  ['#rail', '--rail-dock'],
];

/** Rounded up: a fractional value would leave a hairline of the layer beneath. */
const publish = (name, px) =>
  document.documentElement.style.setProperty(name, `${Math.ceil(px)}px`);

export function trackDockedChrome() {
  const targets = TRACKED
    .map(([selector, name]) => [document.querySelector(selector), name])
    .filter(([element]) => element);

  const measure = () => {
    for (const [element, name] of targets) {
      // offsetHeight rather than the border box from the observer entry: it is
      // zero while the element is hidden, which is exactly what we want the
      // stylesheet to see.
      publish(name, element.offsetHeight);
    }
  };

  measure();

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(measure);
    for (const [element] of targets) observer.observe(element);
  }

  // Rotation and viewport changes do not always resize the elements themselves.
  window.addEventListener('resize', measure, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(measure, 150));

  return measure;
}
