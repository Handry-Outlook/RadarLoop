/**
 * What the product drop-lists offer, and in what order.
 *
 * Two things are decided here, both derived from the catalog rather than written
 * out by hand, because the catalog is edited directly: retiring a product is a
 * one-word change to its entry, and the lists have to follow without anyone
 * having to remember to edit a parallel array.
 *
 *  1. **`listed` decides membership.** It always meant "offer this one", but only
 *     the search box read it — `listLayers` walked `__order` alone, so turning a
 *     product off left it in every drop-list.
 *  2. **Provider decides order**, highest-quality source first: the global
 *     high-resolution composites, then the regional model and radar products,
 *     then the wide-coverage commercial feeds, then everything else. Within each
 *     of those the catalog's own order is kept, so a deliberate arrangement of
 *     related products is not scrambled.
 *
 * Ordering happens inside the sections the headers mark out, never across them.
 * A header names what follows it — "Marine Data", "Global Accumulated
 * Precipitation" — and sorting through one would file products under a heading
 * that does not describe them.
 */

/**
 * Provider ranks, lowest first.
 *
 * Matched against the request URL because that is the one field that cannot be
 * edited into disagreeing with where the data actually comes from. Labels are
 * scrubbed of provider names before anything reads them, so they cannot be used.
 */
const PROVIDER_RANK = [
  [0, /(?:^|\/\/)[^/]*windy\.com/],
  [1, /dtn\.com/],
  [2, /aerisapi\.com|aerisweather\.com/],
];

/** Everything not matched above sorts after the named providers, in place. */
const OTHER_RANK = 3;

/** Heading for products no section named, when the group uses headings at all. */
const LEFTOVER_HEADER = 'Additional Products ↓';

/**
 * Where a product sits in the ordering.
 *
 * MapsGL layers carry no URL — the SDK fetches for them — so they are ranked by
 * their kind instead, alongside the other products from the same source.
 */
export function providerRank(def) {
  if (!def) return OTHER_RANK;
  if (def.kind === 'mapsgl' || def.kind === 'xweather') return 2;
  const url = String(def.url || '');
  for (const [rank, pattern] of PROVIDER_RANK) if (pattern.test(url)) return rank;
  return OTHER_RANK;
}

/**
 * Rewrites every group's `__order` to hold exactly what should be offered.
 *
 * In place, and after the MapsGL merge, so merged products are ordered with the
 * rest rather than appended past the end of the last section.
 *
 * @param {object} catalog
 * @returns {object} the same catalog
 */
export function orderProducts(catalog) {
  for (const defs of Object.values(catalog || {})) {
    const order = defs.__order;
    if (!Array.isArray(order)) continue;

    // Split at headers: [{header, items}, ...], with a leading unheaded section.
    const sections = [{ header: null, items: [] }];
    for (const entry of order) {
      if (typeof entry === 'string') {
        const def = defs[entry];
        // A name that resolves to nothing, or to a product that has been taken
        // out of service, is simply not offered.
        if (def && def.listed) sections[sections.length - 1].items.push(entry);
      } else if (entry && entry.header) {
        sections.push({ header: entry.header, items: [] });
      }
    }

    // Anything listed that no section mentions still has to be reachable — the
    // MapsGL merge appends its products to the end of `__order`, and there may
    // be entries nobody listed at all. They go into a section of their own
    // rather than under whatever heading happens to be last, which had filed a
    // radar layer under "Satellite Precipitation Estimation".
    const known = new Set(sections.flatMap((section) => section.items));
    const leftovers = Object.entries(defs)
      .filter(([key, def]) => key !== '__order' && def && def.listed && !known.has(key))
      .map(([key]) => key);
    if (leftovers.length) {
      const tail = sections[sections.length - 1];
      // Once a heading has opened, a picker cannot get back out of it: the
      // headings become `optgroup`s and every later option joins the open one.
      // So a trailing run needs a heading of its own or it silently reads as
      // more of whatever came last.
      if (tail.header) sections.push({ header: LEFTOVER_HEADER, items: leftovers });
      else tail.items.push(...leftovers);
    }

    const next = [];
    for (const section of sections) {
      // A header with nothing under it is a heading for an empty list.
      if (!section.items.length) continue;
      // Stable: equal ranks keep the order the catalog gave them.
      section.items.sort((a, b) => providerRank(defs[a]) - providerRank(defs[b]));
      if (section.header) next.push({ header: section.header });
      next.push(...section.items);
    }
    defs.__order = next;
  }
  return catalog;
}
