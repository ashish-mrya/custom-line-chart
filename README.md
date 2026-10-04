# Custom Line Chart (Spotfire Mod)

Spotfire visualization mod that plots multiple Y measures as lines, with Spotfire-style Y-axis scale modes.

## Scale modes (from Spotfire Line Chart / Adjusting scales on axes)

| Mode | Behavior |
|---|---|
| **Single** | One shared scale for all Y expressions (default). |
| **Dual** | Left + right scales. Assign each series to Left or Right (click legend side tag, or set `dualScaleAssignments`). |
| **Multiple** | One scale per series/color (trellis-style stacked panels). |

Set scale via the in-chart toolbar, or Visualization properties → `yScaleMode` (`Single` / `Dual` / `Multiple`).

## Getting started

```sh
npm install
npm run build
```

Then in VS Code / Cursor, run the default build task (**Ctrl+Shift+B** / Start watchers). That starts:

- TypeScript watcher
- Mods build watcher (`build/main.js`)
- Mods development server (connect from Spotfire)

## Project layout

| Path | Purpose |
|---|---|
| `mod-manifest.json` | Mod metadata, axes (multi-measure Y), properties |
| `src/main.ts` | Chart render + scale logic |
| `index.html` / `main.css` | Entry + styles |
| `build/main.js` | Bundled output served to Spotfire |

## Properties

- `yScaleMode` — `Single` | `Dual` | `Multiple`
- `dualScaleAssignments` — encoded map `seriesKey=Left|Right` (pipe-separated)
- `seriesStyles` — per-series `Line` / `Points` (Settings → one section per series)
- `showZoomSliders` — show/hide axis zoom sliders
- Size axis — Spotfire built-in **Marker size by** (Visualization properties / legend)
