# Teams app sideload package

This folder contains everything you need to build the Teams app .zip that
gets uploaded via **Teams Admin Center** → *Manage apps* → *Upload custom
app*.

`artifacts/teams-app.zip` is git-ignored build output: a fresh clone has none,
and an old one lying around may be a pre-Phase-0 build (manifest 0.1.5 with
team and group-chat scopes and the removed *Moje dokumenty* tab). **Always build
it with the commands below and check it before uploading.**

## Build the package

Run from the repository root, in bash (`bash -l`). In zsh, run `setopt interactivecomments`
first, or a `#` comment is passed to the command as arguments.

**1. The bot's app id.** `manifest.json` keeps the placeholder
`REPLACE-WITH-BOT-APP-ID` in two places, `id` and `bots[0].botId`; both must be
the bot's Microsoft App ID *before* zipping. When updating the app already in
the catalogue ("Asystent BCR"), this must be that app's id, which is the bot
Function App's `MICROSOFT_APP_ID` setting. Any other id creates a second app.

```bash
MICROSOFT_APP_ID='<MICROSOFT_APP_ID of the bot Function App>'
[[ "$MICROSOFT_APP_ID" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]] \
  && echo 'app id: ok' || echo 'app id: NOT A GUID, stop'
```

**2. Substitute into a copy.** The tracked `manifest.json` keeps its
placeholders, so nothing tenant-specific is committed by accident.

```bash
BUILD="$(mktemp -d)"
cp teams-app/manifest.json teams-app/color.png teams-app/outline.png "$BUILD/"
sed -i.bak "s/REPLACE-WITH-BOT-APP-ID/$MICROSOFT_APP_ID/g" "$BUILD/manifest.json"
rm "$BUILD/manifest.json.bak"
# must print 0
grep -c REPLACE-WITH "$BUILD/manifest.json"
```

If it prints anything but `0`, stop: a placeholder is left and the upload
would be refused.

**3. Zip.** Delete any old archive first; `zip` updates an existing archive in
place rather than replacing it.

```bash
mkdir -p artifacts
rm -f artifacts/teams-app.zip
zip -X -j artifacts/teams-app.zip "$BUILD/manifest.json" "$BUILD/color.png" "$BUILD/outline.png"
rm -rf "$BUILD"
```

**4. Check the archive** before anyone uploads it:

```bash
# must print 0
unzip -p artifacts/teams-app.zip manifest.json | grep -c REPLACE-WITH
unzip -p artifacts/teams-app.zip manifest.json | jq -r '
  [ .version,
    (.bots | map(.scopes | join(",")) | join(";")),
    ((.staticTabs // []) | length),
    (.id == .bots[0].botId) ] | join(" ")'
# must print:  0.2.2 personal 0 true
```

That is: manifest version `0.2.2`, the bot installable in `personal` scope only
(no `team`, no `groupchat`), no static tabs, and `id` equal to `botId`. After the
upload, the admin centre must show version 0.2.2 for the app.

0.2.2 changes only the descriptions (the owner's decision of 28 September 2026: a
client is its `{NIP}@bcr-group.pl` account, and guests have no capability): they
offer the chat and the „Dokumenty księgowe” channel, and say the assistant works
on the account BCR created for the company (`NIP@bcr-group.pl`). Upload it after
the bot build with the matching help card is deployed; until then the catalogue
keeps 0.2.1 (uploaded on 26 September, H-10).

## What you need to add before publishing

| File | Spec | Notes |
|------|------|-------|
| `color.png` | 192×192 PNG, full colour | App icon shown in the app catalogue |
| `outline.png` | 32×32 PNG, transparent + white outline only | App icon shown in the activity bar |

## Sideloading for development

1. In Teams, click *Apps* → *Manage your apps* → *Upload a custom app* →
   *Upload for me*. The app is personal-scope only.
2. Pick the .zip you just built.
3. Open a new chat with the bot and drop a file like `Invoice_03_2026.pdf`. Only
   a client account (`{NIP}@` of a bound Directory row) gets it filed; any other
   account is refused or quarantined by ingestion (`ARCHITECTURE.md` §4.2).
