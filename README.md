# Kid Factory

A local app that makes short illustrated story episodes for kids (about 5 minutes each):
it writes the story, draws the pages, records Thai narration, adds music, and exports an MP4.
The app UI is in Thai.

## Start

Double-click `start.command`. It checks for Node.js and ffmpeg (`brew install node ffmpeg`),
installs dependencies the first time, starts the server on port 4848 (or the next free port
up to 4858) and opens a chromeless app window. Closing the Terminal window stops the app.

On first run the app asks for a Gemini API key; it is stored only in `config.json` inside the data folder.

## Data

Everything generated lives in `~/Documents/KidFactory` by default.
Set `KIDFACTORY_DATA=/some/folder` to use another location.

## Fake mode

`KIDFACTORY_FAKE=1 node src/server.mjs` runs with an offline fake Gemini: no key, no cost,
placeholder content. Useful for trying the UI.

## Tests

`npm test` (never calls the real API).
