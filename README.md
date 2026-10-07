# Atlas VTT Extension - Interactive Dice

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
- **Atlas VTT integration**: each settled roll is sent to Atlas VTT with formula,
  per-die values and total. With Atlas's extension API (1.16 or later) it goes
  through `dice.publish`; an older Atlas gets the `atlas-dice-rolled` event as
  before. If Atlas VTT is not installed nothing happens, and the dice work on
  their own.
- **Dice packs as Atlas dice looks**: with Atlas VTT 1.16 or later, every pack
  is registered as a dice look, so Atlas's own 3D dice can wear your faces. From
  1.18 they wear the pack's whole faces, and Atlas's asset manager gets a
  **Dice packs** tab to pick a pack per collection.
- **Dice colours per collection**: with Atlas VTT 1.18 or later, each
  collection's settings get a **Dice** tab listing colours (a name and a colour
  each). Atlas's dice tray offers them, and so does this plugin's dice panel while
  a map of that collection is open.
- **Atlas-style controls**: dice icons, count badges, right-click a die to remove it.
- **Dice packs**: a folder is a set. Face art, normal maps, colour, per-die size,
  finish, bevel and the layout of each net all live in the pack's `pack.json`.

## Usage

1. Click the dice icon in the ribbon, or run **Toggle dice roller** from the
   command palette.
2. Click dice in the controls panel to add them. Right-click one to add it in a
   colour (your own, and the open Atlas map's collection colours), or to remove
   one when there are no colours.
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

### Dice packs in Atlas

With Atlas VTT's extension API 1.16 or later (capability `dice-looks`), each
folder under `dice/` shows up in Atlas's dice look setting under the pack's
name (`name` in its `pack.json`, else the folder name), with a picture of its
d20. Atlas keeps its own dice, throw and sounds; only the faces and the body
colour change.

- **Atlas 1.18 or later: whole faces.** Each face is cut from the pack's sheet
  with its background and numeral (`fill: 'face'`) and laid on Atlas's outline
  of that face, the digit upright. The sheet's transparency is kept, so the body
  colour shows through it: the pack's `color`, or the colour a die is rolled in.
  A pack with normal maps gives Atlas their relief (`bump`).
- **Atlas 1.16 and 1.17: digits.** Only each digit is cut out, and Atlas prints
  it on its own card where it prints its numeral.
- **Dice packs tab** (1.18, `asset-tabs`). Atlas's asset manager lists every
  pack with its picture, a button to read the packs again and one to open their
  folder. **Use for collection** makes a pack the collection's dice look
  (`dice-look-choice`), and the pack in use is marked.
- **Dice tab** in a collection's settings (1.18, `collections`): the colours that
  collection's dice can be rolled in, a name and a colour each. They are kept with
  the collection in Atlas's asset index (on this device), offered in Atlas's dice
  tray (`dice-colours`) and in this plugin's dice panel while a map of that
  collection is open, and sent with each roll as the die's `color` and `colorName`.
- Atlas looks need to know which way up each digit is drawn on the sheet. A
  face cell takes an optional `"up"`: the direction the digit's top points on the
  sheet, in degrees clockwise from the top of the image. The default pack has it
  on every cell. A d6 cell without it is read from its `rotation`; any other face
  without it keeps Atlas's own numeral, and a d4 needs `vertices` as it always has.
- A pack's per-die `color` is painted under that die's faces, since Atlas has one
  body colour per look; such a die does not take the colour it is rolled in.
- An optional `ink` (`#rrggbb`) colours the numerals Atlas prints where a face has
  no art.
- Click the reload button next to **Dice pack** (or in the Dice packs tab) after
  editing a pack to register it again. On an Atlas without the API nothing changes.

## Installation

### Community plugins

Settings → Community plugins → Browse → search **Atlas VTT Extension - Interactive Dice** →
Install → Enable.

### Manual

Download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/evolJoaoBento/atlas-physical-dice/releases/latest)
into `<vault>/.obsidian/plugins/atlas-physical-dice/`, reload Obsidian and enable
the plugin.

## Privacy

The plugin makes no network requests. Rolls, dice looks and dice colours are passed
to Atlas VTT inside Obsidian and never leave your device.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check and production build
```

The browser test harness (Chrome DevTools Protocol smoke checks, sheet
calibration scripts) is not part of the plugin and lives in the upstream
[obsidian-physical-dice](https://github.com/evolJoaoBento/obsidian-physical-dice)
repository.

## Credits

- [Three.js](https://threejs.org/) and [cannon-es](https://github.com/pmndrs/cannon-es).
- [dice-box](https://github.com/3d-dice/dice-box) and
  [react-3d-dice](https://github.com/aqandrew/react-3d-dice) for dice geometry
  and approach. See [Credits.md](Credits.md).

## License

[MIT](LICENSE) © 2026 João Bento
