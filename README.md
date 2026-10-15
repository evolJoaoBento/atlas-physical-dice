# Atlas VTT Extension - Interactive Dice

Throw real 3D dice over your notes, and send every result to [Atlas VTT](https://github.com/ByteMirror/atlas-vtt)'s dice log.

Works on its own, and with Atlas VTT from Community plugins. A fork of [Physical Dice](https://github.com/evolJoaoBento/obsidian-physical-dice).

## Install

Settings → Community plugins → Browse → search **Atlas VTT Extension - Interactive Dice** → Install → Enable.

## Roll dice

1. Click the dice icon in the ribbon, or run **Toggle dice roller** from the command palette. The dice panel opens over your note.
2. **Add dice:** click a die (d4, d6, d8, d10, d12, d20, d100). The badge counts how many you have; up to 50.
3. **Remove a die:** right-click it. If you have dice colours, right-click offers them instead (see below).
4. **Roll:** click **Roll**, or grab a die on the table and throw it.
5. **Read the result:** the total shows in the panel, each die named, e.g. `Red d20=14 + d6=3 = 17`. Click it to copy it.
6. **Caught dice:** a die that lands tilted on an edge is highlighted. Click **Reroll caught dice** to throw only those.

Run **Toggle dice roller** again, or click the icon, to close the panel.

## With Atlas VTT

Open a map in Atlas, then roll. Every result goes into that map's dice log and shows as Atlas's result card, in Atlas's player window too (and to your online players with Atlas VTT Connect). Nothing else to set up. Without Atlas, or with no map open, the dice simply work on their own.

## Dice colours

Settings → **Dice colours**: add colours with a name, e.g. "Fire". In the dice panel, right-click a die and pick a colour to add it in that colour. The roll names each die by its colour, and Atlas's log keeps the colour.

## Dice packs

A dice pack is a folder with the dice's face art, colours, sizes and finish.

1. Settings → **Dice pack**: pick a pack from the list.
2. **Make your own:** click the folder button next to **Dice pack**, copy `Texture-Pack-Default` under a new name, edit its images and `pack.json`, click the reload button, then pick it. The format is in [dice/README.md](dice/README.md).

The default pack (white with black numbers) belongs to the plugin and is rewritten on update, so always edit a copy.

## Settings

| Setting | What it does |
|---|---|
| Dice colours | Colours you can add dice in |
| Dice pack | The set you roll; buttons to open the packs folder and reload it |
| Dice size | Size of the whole set |
| Dice shadows | Soft shadows under the dice |
| Ambient / directional light | Strength, colour and position of the light on the dice |
| Motion threshold | How still the dice must be before the result is read: higher waits longer |
| Face detection tolerance | How flat a die must land to count; others are caught |
| Highlight completed dice | A glow on settled dice, and its colour |

## Atlas builds with the extension API

These need Atlas's extension API, which no released Atlas has yet. On Atlas from Community plugins they stay off and everything above works as described.

- **Packs as Atlas dice looks:** every pack appears in Atlas's own dice look setting, so Atlas's 3D dice wear your faces.
- **Dice packs tab:** Atlas's asset manager lists your packs. **Use for collection** gives a collection its own dice look.
- **Collection dice colours:** a **Dice** tab in each collection's settings, offered in Atlas's dice tray and in this plugin's panel while a map of that collection is open.

Pack authors: how faces become Atlas looks (`up`, `ink`, per-die `color`) is in [dice/README.md](dice/README.md).

## Privacy

No network requests. Rolls stay inside Obsidian: they go only to Atlas VTT on your device.

## Development

`npm install`, then `npm run dev` (watch) or `npm run build` (type-check and production build). Releases are built and attested by GitHub Actions from a tag equal to the manifest version.

## Credits

[Three.js](https://threejs.org/), [cannon-es](https://github.com/pmndrs/cannon-es), and [dice-box](https://github.com/3d-dice/dice-box) and [react-3d-dice](https://github.com/aqandrew/react-3d-dice) for dice geometry. See [Credits.md](Credits.md).

## License

[MIT](LICENSE) © 2026 João Bento
