# trmnl-screenshots
Create pngs for my weather station

Batched screenshot runner for the METEOframe TRMNL dashboards. City list,
timezones and quiet hours come from wetterstation's `/locations` endpoint --
nothing is hardcoded here. See `TRMNL.md` for how the pipeline works and
`package.json`'s `test` script for the quiet-hours unit tests
(`npm test`).
