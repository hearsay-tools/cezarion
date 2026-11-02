# Keep the cockpit readable in light and dark themes

A repository owner needs the cockpit to suit their screen and reading conditions. They can switch between light and dark themes and tighten spacing while keeping the settings text readable.

## Identity

Nobody is signed in. The cockpit runs locally without accounts.

## Page

Sam Reed starts on the Appearance settings page at `/settings/global/appearance`.

## Given

### People

| Name | Role |
|------|------|
| Sam Reed | Repository owner |

### Projects

| Name |
|------|
| cedar-tools |
| river-docs |

### Tasks

| Title | Project | Status | Archived | Created date | Created time |
|-------|---------|--------|----------|--------------|--------------|
| Audit invoice export | cedar-tools | done | false | 2026-10-01 | 09:00 |
| Review invoice totals | cedar-tools | done | false | 2026-10-01 | 10:00 |
| Polish settings labels | cedar-tools | cancelled | false | 2026-10-01 | 11:00 |
| Archive invoice prototype | cedar-tools | done | true | 2026-10-01 | 08:00 |
| Invoice partner migration | river-docs | done | false | 2026-10-01 | 12:00 |

## Visible

- The desktop cockpit places settings navigation to the left of the main settings content.
- Theme offers System, Light, and Dark with a visible selected state.
- Dark uses dark page surfaces and light main text.
- Light uses near-white page surfaces and dark main text.
- Theme changes apply immediately and survive a page reload in this browser.
- The preview displays a sample task title in the selected theme.
- Compact density reduces vertical gaps without reducing the text size.
- Density survives a page reload.

## Behavior

1. Sam selects "Light" in "Theme".
2. Sam reloads the Appearance settings page with "Light" selected.
3. Sam selects "Dark" in "Theme".
4. Sam selects "Compact" in "Density".
5. Sam leaves and later comes back to the Appearance settings page by reloading it.

## Acceptance criteria

All criteria are mandatory. Each asks about one thing the user can see.

### Before Sam selects anything

- **AC1:** Before Sam selects anything, does the heading say "Appearance · every project"?
- **AC2:** Before Sam selects anything, is "Dark" selected in "Theme"?
- **AC3:** Before Sam selects anything, does the page have a dark background?
- **AC4:** Before Sam selects anything, is the main settings text light against the dark background?
- **AC5:** Before Sam selects anything, does settings navigation sit to the left of the main settings content?
- **AC6:** Before Sam selects anything, does the preview show "Review finalization retries"?
- **AC7:** Before Sam selects anything, is "Comfortable" selected in "Density"?

### After Sam selects Light

- **AC8:** After Sam selects "Light", is "Light" selected in "Theme"?
- **AC9:** After Sam selects "Light", does the page have a near-white background?
- **AC10:** After Sam selects "Light", is the main settings text dark against the light background?
- **AC11:** After Sam selects "Light", is "Review finalization retries" readable in the preview?

### After Sam reloads Appearance with Light selected

- **AC12:** After Sam reloads Appearance with "Light" selected, is "Light" selected in "Theme"?
- **AC13:** After Sam reloads Appearance with "Light" selected, does the page have a near-white background?

### After Sam selects Dark

- **AC14:** After Sam selects "Dark", is "Dark" selected in "Theme"?
- **AC15:** After Sam selects "Dark", does the page have a dark background?

### After Sam selects Compact

- **AC16:** After Sam selects "Compact", is "Compact" selected in "Density"?
- **AC17:** After Sam selects "Compact", are the vertical gaps between the settings groups smaller than before Sam selected "Compact"?
- **AC18:** After Sam selects "Compact", is the preview title "Review finalization retries" the same text size as before Sam selected "Compact"?

### After Sam comes back to Appearance by reloading it

- **AC19:** After Sam comes back to Appearance by reloading it, is "Dark" selected in "Theme"?
- **AC20:** After Sam comes back to Appearance by reloading it, is "Compact" selected in "Density"?
