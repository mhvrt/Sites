# Browser Site Monitor

Reusable Playwright-based browser monitoring for checking page rendering, external-link navigation, referrer handling, and multi-page journeys.

The public repository contains only generic code. Target and source URLs, access tokens, IP history, raw reports, screenshots, traces, cookies, storage state, and detailed routes must remain private.

This project does not bypass CAPTCHAs, anti-bot controls, authentication, or access restrictions. It does not submit forms, make purchases, click advertisements, or use stealth plugins.

## Public output

Scheduled runs expose only a safe summary: success or failure, browser profile, device category, number of pages visited, and duration.

## Required repository secrets

- `TARGET_URL`
- `SOURCE_URL_1`
- `SOURCE_URL_2` (optional)
- `SOURCE_URL_3` (optional)
- `PRIVATE_REPORTS_TOKEN`
- `PRIVATE_REPORTS_REPO`
- `PRIVATE_REPORTS_BRANCH` (optional; defaults to `main`)

Use a fine-grained GitHub token restricted to the private reports repository with Metadata read and Contents read/write permissions.

## Private data

Raw JSON reports and `ip-history.csv` are sent to the private reports repository. They are never committed to this public repository and are never uploaded as public workflow artifacts.

## Local validation

```bash
npm install
npm run check
```

## License

MIT
