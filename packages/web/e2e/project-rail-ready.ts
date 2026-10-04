/** #795 loaded trace: a stable loading body preceded the rail's expanded commit. */
export function expandedRailSampleExpression(): string {
  return `(() => {
    const rail = document.querySelector('[data-slot="project-rail"]');
    const toggle = rail?.querySelector('[data-slot="rail-expand-toggle"]');
    const name = rail?.querySelector('[data-slot="rail-project-name"]');
    const ink = name?.parentElement;
    // Independent semantic readiness, including reloads before the rail mounts.
    if (rail?.getAttribute('data-expanded') !== 'true' || toggle?.getAttribute('aria-expanded') !== 'true' || !name || !ink) return null;
    // #758: native rendering precedes every measured target's box/style reads.
    if (![rail, name, ink].every(el => el.checkVisibility({ contentVisibilityAuto: true }))) return null;
    return { width: rail.getBoundingClientRect().width, opacity: getComputedStyle(ink).opacity };
  })()`
}
