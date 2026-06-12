# Teams app sideload package

This folder contains everything you need to build the Teams app .zip that
gets uploaded via **Teams Admin Center** → *Manage apps* → *Upload custom
app*.

## Build the package

```bash
cd teams-app
zip ../artifacts/teams-app.zip manifest.json color.png outline.png
```

## What you need to add before publishing

| File | Spec | Notes |
|------|------|-------|
| `color.png` | 192×192 PNG, full colour | App icon shown in the app catalogue |
| `outline.png` | 32×32 PNG, transparent + white outline only | App icon shown in the activity bar |

The `id` and `bots[0].botId` fields in `manifest.json` must both be replaced
with the Bot's Microsoft App ID **before** packaging.

## Sideloading for development

1. In Teams, click *Apps* → *Manage your apps* → *Upload a custom app* →
   *Upload for me or my teams*.
2. Pick the .zip you just built.
3. Open a new chat with the bot and drop a file like `Invoice_03_2026.pdf`.
