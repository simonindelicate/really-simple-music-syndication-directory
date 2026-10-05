# Catalogue Directory

An open list of music catalogues: musicians and labels publishing their own records from their own websites, in the [catalogue format](https://github.com/simonindelicate/Full-generic-music-streaming-app/blob/main/docs/catalogue-format.md), which any player, radio or app can read.

It's built so that nobody controls the list:

- **Listing is mechanical, never editorial.** Any address that serves a working catalogue, shared with other sites, is listed. Nobody approves anything.
- **Only the owner removes an entry.** A catalogue whose owner makes it private is dropped at the next daily check. One that stays broken for a week is dropped too. Nothing else removes it.
- **The whole list is one public file,** `directory.json`, with its full history in this repository. Anyone can download, use or republish it.
- **Anyone can run a copy,** and copies read each other's lists. A catalogue added to one directory reaches the rest, and no single copy can remove it from the others.

It costs nothing to run: GitHub hosts the page and the list and runs the checks, and a tiny Cloudflare Worker on the free plan takes submissions.

## The example player

`listen.html` is a small multi-artist streaming site built on nothing but the list and the catalogues it points to. It shows every catalogue, then a catalogue's records, then a record's tracks. It plays them in one player, with "Shuffle everything" picking songs from right across the directory. It keeps nothing of its own: each catalogue is fetched from the musician's site when it's opened, the music streams from their site, and every song links back to it. It's meant as a demonstration of what anyone can build on the list, and as a starting point to copy.

## How it fits together

```
 musician's site ──/catalogue──▶  checked by  ◀──── submission page / software ping
                                      │                       │
                         scripts/check.mjs (GitHub Action)    worker/worker.js (Cloudflare)
                         hourly: new submissions              checks the address straight away,
                         daily: recheck everything,           then queues it
                                merge peers' lists
                                      │
                                      ▼
                     directory.json  ──▶  index.html (GitHub Pages), apps, other directories
```

## Using the list

`directory.json` is served with `Access-Control-Allow-Origin: *` by GitHub Pages, so apps running in a browser can read it directly.

```json
{
  "directoryVersion": "1",
  "name": "Catalogue Directory",
  "updated": "2026-10-05T03:43:00.000Z",
  "count": 1,
  "catalogues": [
    {
      "url": "https://theindelicates.example",
      "feed": "https://theindelicates.example/catalogue",
      "name": "The Indelicates",
      "description": "…",
      "site": "https://theindelicates.example/",
      "artworkUrl": "https://…/cover.jpg",
      "releases": 14,
      "tracks": 160,
      "playable": 152,
      "artists": ["The Indelicates"],
      "genres": ["Indie"],
      "firstSeen": "…", "lastChecked": "…", "lastOk": "…", "failures": 0
    }
  ]
}
```

`url` is the catalogue's base address, which identifies it; the catalogue itself is at `feed`. Everything else is a cached summary, refreshed daily: always read the catalogue itself for the music. Readers should ignore fields they don't recognise.

## Announcing a catalogue from software

Software that publishes catalogues can tell a directory about one with a single request:

```
GET https://<the directory's worker>/ping?url=https://their-site.example
```

It's checked at once and listed within the hour if it works and is shared. Announce to several directories if you like; it does no harm.

## Setting up your own copy

1. **Copy the code.** Fork this repository, or create a new one from its files. Then edit `config.json`:
   - `name` and `description`, shown on the page
   - `repository`: your repository's address
   - `takedownContact`: where people should send takedown requests
   - `peers`: other directories' `directory.json` addresses, to share lists with them
2. **Switch on the page.** In the repository's Settings → Pages, choose to deploy from the `main` branch, root folder. Your directory is then at `https://<you>.github.io/<repository>/`.
3. **Switch on the checks.** In the Actions tab, enable workflows if GitHub asks. The workflow runs hourly and daily by itself. Run it once by hand ("Update the directory" → Run workflow) to check it works.
4. **Optionally, take submissions.** Without this step your copy still works as a mirror of its peers.
   1. In Cloudflare (a free account is enough), go to Workers & Pages → KV, and create a namespace called `QUEUE`.
   2. Create a Worker and paste in `worker/worker.js` as it is.
   3. In the Worker's settings, bind the namespace as `QUEUE`, and add a secret called `TOKEN` holding a long random password.
   4. Alternatively, use `wrangler` with `worker/wrangler.toml`.
   5. In GitHub, add the same password as a repository secret called `WORKER_TOKEN`, and the Worker's address as a repository variable called `WORKER_URL`.
   6. Put the Worker's address in `config.json` as `workerUrl`, so the page shows the submission form.

People without a Worker can still add catalogues to their copy through a pull request that adds a line to `submissions.txt`, one address per line.

## Running the checks by hand

```
node scripts/check.mjs new    # queued submissions only
node scripts/check.mjs full   # recheck everything and merge peers
```

This needs Node 18 or later and no dependencies.

## Takedowns

A directory lists addresses; it doesn't host music. Copyright complaints about the music itself belong with the host of the site in question. A directory's operator may still choose to drop an entry. To do so, delete it from `directory.json`, and add the address to an `exclude` list in `config.json` if it shouldn't be re-added. That decision affects only that one copy of the directory.

## Licence

The code is under the MIT licence. `directory.json` is dedicated to the public domain (CC0), so anyone can reuse the list without asking.
