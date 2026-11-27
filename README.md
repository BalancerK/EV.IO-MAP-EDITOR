# EV.IO Map Editor

Build ev.io maps in the browser and export them as `.evmap` files, without Unity.

**Open it: <https://balancerk.github.io/EV.IO-MAP-EDITOR/>**

It is a static site with no build step: to run your own copy, serve the folder from any static web
server (for example `python -m http.server`) and open `index.html`.

> An unofficial, fan-made tool. It is not made by, affiliated with or endorsed by ev.io.

## What you can build

- **Blocks**: box, floor, wall, ramp, stairs, corner wedge, pillar, platform. Snap to a grid, move,
  rotate and resize with the gizmo or by typing numbers.
- **Fast building**: Shift-click or drag a box to select several pieces, then move or turn them
  together; copy and paste (Ctrl+C / Ctrl+V, also between maps and tabs); turn 90° with `[` / `]`;
  *Mirror copy* across the map's centre line (team spawns swap) for symmetrical maps, or flip in
  place; hide (H) and lock pieces from the scene list. Arrow keys move the view; Space
  (or PgUp) raises it and Shift (or PgDn) lowers it.
- **Collision per block**: solid, decoration (visible, no collision) or invisible wall.
- **Materials**: colour, roughness, opacity, glow.
- **Gameplay objects**: free-for-all and team spawns with facing, weapon spawns, teleporters with
  links (placing one right after another pairs them), bot nav nodes (chained as you place them),
  battle royale circle.
- **Open any .evmap**: official maps, community maps or your own exports. Every piece of the map
  becomes something you can select, move, turn, resize, mirror, hide or delete, and its spawns,
  weapon spawns, teleporters, nav nodes, camera paths, lights and sky become editable like the
  editor's own. Its meshes, materials and textures are written back byte for byte, so an untouched
  map exports exactly as it was. The file is kept in your browser, so a reload brings it back.
- **Walk test**: play the map in first person (button or **P**) with ev.io's own movement numbers:
  walking and sprint speed, acceleration, air control, gravity, jump height and double jump, the
  player's size and step-up height, teleporters and the kill zone. Check that every jump can be
  made, every doorway fits and every spawn leads somewhere before you upload.
- **Bot nav nodes, generated**: *Auto nav* fills every walkable floor with nodes and links the ones a
  bot can walk between (up ramps and stairs, through doorways; never through walls, off ledges or
  under low ceilings), then reports separate areas and spawns bots cannot reach. The checklist keeps
  checking that as you edit.
- **Menu camera paths**: frame each shot by looking through the camera and flying it (right-drag to
  look, WASD/Q/E to move, Enter to save); drag the start and end cameras with the gizmo; preview a
  path or play the whole menu loop; or generate six paths circling the map as a starting point.
- **Looks like the game**: rendered the way ev.io 1-7-1 renders maps (toon shading through the same
  gradient, its shadow-strength and fog shader patches, VSM shadows, the same shadow camera and
  colour handling), so what you build is what players see. A *work light* checkbox brightens the
  view while building; it never affects exports or images.
- **Sky and light**: gradient sky, fog, view distance, ambient light, up to four sun lights.
- **Checklist**: ev.io's submission checklist, run live (spawns, collision, lights, kill zone at
  y = −30, ...).

- **Export images**: renders the 166×70 PNG thumbnail and the 2000×902 JPEG large image that
  ev.io's upload form asks for, from the current view or any menu camera path, without the
  editor's grid and markers.

- **Export as glTF**: saves the map as a `.glb` (glTF 2.0) model for Blender, the three.js editor
  or any 3D tool: every visible piece with its materials and textures, the sun lights, and empty
  markers for spawns, weapon spawns and teleporters, placed the way players see the map (the game
  mirrors the file in x on load). Works for official maps you open as well as your own. Invisible
  collision, lightmaps, the sky and fog are not included.

Projects save as `.mapproject.json` (and autosave in the browser). **Export .evmap** writes the game file.

## Submitting to ev.io

Upload at <https://ev.io/node/add/map> with a 166×70 PNG thumbnail and a 2000×902 JPEG large image
(the editor's **Export images** button makes both).
Until ev.io staff approve a map, only its author can play it from custom server.

## Playing community maps on the custom server

[`maps/extra-maps.json`](maps/) is the shared list of extra ev.io maps that the EV.IO custom server
and the EV.IO UI Enhancer extension add to their map lists. Uploaded a map to ev.io? Add its id
with the **Add ev.io map** workflow (Actions tab) and it is playable there within minutes. See
[maps/README.md](maps/README.md).

## How the file is made

`src/evmap/format.js` reads and writes `.evmap` exactly as the ev.io client's own reader
(`readEVMapFile`, build 1-7-1) parses it. `src/model/compile.js` turns the editor's document into
that structure:

- The client mirrors every map in x on load (maps were authored in Unity), so positions and
  normals are mirrored and each triangle's winding is flipped to stay counter-clockwise in file
  space, as in official maps.
- Spawn and teleporter yaw are stored as `270 − yaw` degrees; camera nodes store the camera's +z
  (forward) and +y (up) axes, which the client mirrors back.
- Blocks are merged into one mesh per material, collision kind and shadow setting (split at 21,000
  triangles), because the object count, not the triangle count, is what costs frame rate.
- The client cannot read an empty vertex buffer (it does not skip the marker byte), so the writer
  refuses to emit one.

## Tests

```
node tests/test_roundtrip.js path/to/official.evmap   # read -> write -> read an official map
node tests/test_compile.js                            # shapes, winding, camera maths, physics load
node tests/test_edit.js                               # selection, copy/paste, mirror
node tests/test_navgen.js                             # bot nav generation, server pathfinder
node tests/test_walk.js                               # walk-test movement and collision
node tests/test_import.js [maps...]                   # open -> export -> compare real .evmap files
python -m http.server 8765 --bind 127.0.0.1           # then, in another terminal:
node tests/browser_smoke.js                           # real mouse events in headless Chrome
```

The tests also load each result with the
[EV.IO custom server](https://github.com/BalancerK/EV.IO-Custom-Server)'s independent `.evmap`
parser and physics builder. They expect a checkout of it next to this one
(`../EV.IO-Custom-Server`); point `EVIO_SERVER_DIR` elsewhere if yours lives somewhere else.

## License

[MIT](LICENSE)
