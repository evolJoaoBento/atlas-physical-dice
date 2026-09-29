# Atlas VTT Physical Dice

Roll 3D physical dice over your notes in Obsidian, and send every result to
the [Atlas VTT](https://github.com/ByteMirror) plugin so it shows in Atlas' roll toast,
roll log and player view.

A fork of [Physical Dice](https://github.com/evolJoaoBento/obsidian-physical-dice),
reworked around Atlas VTT: the online chat and API are gone, and the controls
match Atlas' own dice panel.

## Features

- **Seven dice types**: d4, d6, d8, d10, d12, d20 and a percentile d100.
- **Real physics**: Three.js rendering and cannon-es physics. Click **Roll**, or
  grab a die and throw it.
- **Caught dice**: a die that lands on an edge is highlighted and can be rerolled.
- **Read off the die**: the number reported is the number printed on the face
  that is up. A d4 is read at its apex.
- **Atlas VTT integration**: each settled roll is sent to Atlas VTT as its
  `atlas-dice-rolled` event, with formula, per-die values and total. If Atlas VTT
  is not installed nothing happens, and the dice work on their own.
- **Atlas-style controls**: dice icons, count badges, right-click a die to remove it.
- **Dice packs**: a folder is a set. Face art, normal maps, colour, per-die size,
  finish, bevel and the layout of each net all live in the pack's `pack.json`.

## Usage

1. Click the dice icon in the ribbon, or run **Toggle dice roller** from the
   command palette.
2. Click dice in the controls panel to add them. Right-click one to remove it.
3. Click **Roll**, or drag a die and throw it.
4. The total shows in the panel and, with Atlas VTT installed, in Atlas.

## Settings

| Setting | What it does |
|---|---|
| Dice pack | Folder under the plugin's `dice/` directory holding the set |
| Dice size | Overall size of the set; the pack sets each die's size within it |
| Shadows | Soft shadows under the dice |
| Lighting | Ambient and directional light: colour, strength, position |
| Motion threshold | How still the dice must be before the result is read |
| Face detection tolerance | How flat a face must land to count; others are caught |
| Highlight completed dice | Glow on settled dice, and its colour |

## Dice packs

On first load the plugin writes its default set to
`<vault>/.obsidian/plugins/atlas-physical-dice/dice/Texture-Pack-Default/`.
The default set is white with black numbers. That folder belongs to the plugin
and is refreshed on update. To make your own, click the folder button next to
**Dice pack** in the settings, copy the default folder under a new name, edit
the art and `pack.json`, click the reload button and pick it from the list. See [dice/README.md](dice/README.md) for the format.

## Installation

### Community plugins

Settings → Community plugins → Browse → search **Atlas VTT Physical Dice** →
Install → Enable.

### Manual

Download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/evolJoaoBento/atlas-physical-dice/releases/latest)
into `<vault>/.obsidian/plugins/atlas-physical-dice/`, reload Obsidian and enable
the plugin.

## Privacy

The plugin makes no network requests. Rolls are passed to Atlas VTT as an
in-app event inside Obsidian and never leave your device.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check and production build
```

`harness/` drives a real Obsidian over the Chrome DevTools Protocol for
screenshots and smoke checks; see [harness/README.md](harness/README.md).

## Credits

- [Three.js](https://threejs.org/) and [cannon-es](https://github.com/pmndrs/cannon-es).
- [dice-box](https://github.com/3d-dice/dice-box) and
  [react-3d-dice](https://github.com/aqandrew/react-3d-dice) for dice geometry
  and approach. See [Credits.md](Credits.md).

## License

[MIT](LICENSE) © 2026 João Bento
