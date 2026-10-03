/** #795 review reproduction: body readiness does not render separately measured lazy rows. */
export function assistantWidthExpression(): string {
  return `(() => {
    // #795 review/#758: flat mode mounts skipped earlier assistants. At the live
    // tail measure the latest already-rendered assistant; never move reader intent.
    const assistant = [...document.querySelectorAll('[data-slot="assistant-message"]')]
      .reverse().find(el => el.checkVisibility({ contentVisibilityAuto: true }));
    return assistant ? assistant.getBoundingClientRect().width : null;
  })()`
}

/** Measure each card separately; scrolling separated cards together cannot render them all. */
export function messageClockExpression(selector: string, headingSelector?: string): string {
  return `(() => {
    const card = document.querySelector(${JSON.stringify(selector)});
    const clock = card?.querySelector('[data-slot="message-time"]');
    const heading = ${headingSelector ? `card?.querySelector(${JSON.stringify(headingSelector)})` : 'null'};
    if (!card || !clock || (${Boolean(headingSelector)} && !heading)) return null;
    // #795 review/#758: scrolling requests a future rendered frame. Observe each
    // measured node before scrolling/boxes and reject this task's skipped sample.
    const rendered = [card, clock, ...(heading ? [heading] : [])]
      .every(el => el.checkVisibility({ contentVisibilityAuto: true }));
    card.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (!rendered) return null;
    const box = card.getBoundingClientRect(), time = clock.getBoundingClientRect();
    return { top: time.top - box.top, right: box.right - time.right,
      overflow: card.scrollWidth > card.clientWidth,
      headingHeight: heading ? heading.getBoundingClientRect().height : null };
  })()`
}
