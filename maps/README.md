# Extra maps list

`extra-maps.json` lists ev.io maps that are not in the official map catalogue snapshot, usually
community maps uploaded at <https://ev.io/node/add/map>. It is published at

**<https://balancerk.github.io/EV.IO-MAP-EDITOR/maps/extra-maps.json>**

and both the [EV.IO custom server](https://github.com/BalancerK/EV.IO-Custom-Server) and the
EV.IO UI Enhancer extension merge it into their map lists, so a map added here becomes playable
there without a server restart, an extension rebuild or a Chrome Web Store release.

## Adding a map

The map must be uploaded to ev.io first (it does not need staff approval). Take its id from its
page, e.g. `https://ev.io/node/830` → `830`.

- **On GitHub:** Actions → **Add ev.io map** → Run workflow, enter the id(s). The workflow updates
  this file and commits it.
- **Locally:** `node scripts/add_map.js 830`, then commit and push.

Run it again for the same id after a map is re-uploaded; `--remove <id>` (or the workflow's
*remove* action) takes a map off the list.

Changes reach players in a few minutes: GitHub Pages republishes in a minute or two and caches for
up to 10 minutes; the custom server re-reads the list every 10 minutes, the extension each time its
game server starts.

## Format

```json
{
  "version": 1,
  "maps": [
    {
      "nid": 830,
      "title": "The Field",
      "author": "BalancerK",
      "evmapUrl": "https://ev.io/sites/default/files/maps/the-field_0.evmap",
      "thumbUrl": "https://ev.io/sites/default/files/map_thumbs/....png",
      "largeImageUrl": "https://ev.io/sites/default/files/map_large_image/....jpg",
      "approvedForPrivateGames": false,
      "updated": "2026-11-25T10:52:03+00:00"
    }
  ]
}
```

Readers accept an entry only if `evmapUrl` is an `.evmap` file on ev.io's own file store
(`https://ev.io/sites/default/files/maps/`), so the list can never point players' browsers or the
server at another site.
