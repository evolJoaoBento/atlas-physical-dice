# Changelog

## 1.1.0-beta.1

Works with Atlas VTT's extension API up to 1.18 (dice looks, whole-face looks,
the asset manager's tabs, collection data, dice colours and a dice look per
collection). Everything is feature-detected, each piece on its own: on an Atlas
without the API the plugin behaves as 1.0.1, and on 1.16 or 1.17 it does what
those offer.

- **Dice packs as Atlas dice looks** (`dice.registerLook`, capability
  `dice-looks`). Every pack is registered with a picture of its d20 (`preview`),
  again when Atlas becomes ready later or the packs are reloaded.
  - Atlas 1.18 or later: each face is the pack's whole face, background and
    numeral, laid on Atlas's outline of it with the digit upright (`fill: 'face'`).
    The sheet's transparency is kept, so the pack's colour, or the colour a die is
    rolled in, shows through. A pack's normal maps become Atlas's relief (`bump`).
    A d4 numbered the other way round from Atlas's gets each number placed at its
    own corner.
  - Atlas 1.16 and 1.17: only the digits, which Atlas prints on its own card.
- **Dice packs tab** in Atlas's asset manager (`ui.addAssetTab`, `asset-tabs`):
  the packs with their pictures, reload and open-folder buttons, and **Use for
  collection** (`dice.useLook` with the collection; `dice-look-choice`). The pack in
  use is marked from `dice.lookFor`.
- **Dice colours per collection**: a **Dice** tab in each collection's settings
  (`ui.addCollectionSettingsTab`, `collections`), with a name and a colour per
  entry and the same suggested colours as Atlas's own. Kept with
  `collections.setData`, offered in Atlas's dice tray (`dice.registerColours`,
  `dice-colours`), and in the dice panel's right-click colours while a map of that
  collection is open.
- Rolls go through `dice.publish` with `throw: false` when the API is present, with
  each die's `color` and `colorName`. The `atlas-dice-rolled` DOM event stays as the
  fallback for an older Atlas (or if `publish` refuses a roll).
- Pack format: face cells take an optional `up` (which way the digit points on the
  sheet). The default pack has it; its files are refreshed on update.
- Renamed Atlas VTT Extension - Interactive Dice (the plugin id stays
  `atlas-physical-dice`).
- Settings: notes on Atlas's dice looks and collection colours; the reload button
  also registers the looks again.

## 1.0.1

Dice colours picked per die (right-click a die), dice that fall and settle like
real dice, Obsidian's community-plugin lint, and a release workflow with build
provenance.

## 1.0.0

First release as Atlas VTT Physical Dice: 3D physical dice that send each roll to
Atlas VTT.
