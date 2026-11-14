# Operations: releases, deployment checks and rollback

## How changes reach the live site

- **Code** reaches `main` through pull requests. CI (`.github/workflows/ci.yml`) runs lint, unit tests, integration tests against a simulated network, the data contract and a headless-browser UI test on every push and pull request.
- **Data** is committed to `main` only by the refresh workflow (`.github/workflows/refresh.yml`, as `github-actions[bot]`), twice a day and after build-code changes. It runs the tests and the data contract before committing. A partial refresh still commits (previous good values marked stale), but it does not advance `last_successful_refresh` and does not take the day's snapshot slot. After two partial runs in a row, it opens an issue labelled `data-refresh`.
- **Vercel** deploys every push to `main`.

Recommended repository setting (owner action): protect `main` and require the `test` check for pull requests, while allowing `github-actions[bot]` to push data commits (otherwise the refresh cannot commit).

## Verify a deployment

```sh
git pull && node scripts/check-deploy.mjs            # compares data/latest.json, app.js and index.html with the live site
```

Every file should print `match`. A data mismatch right after a refresh usually means Vercel is still deploying; re-run after a minute.

## Roll back

- **Site (fastest):** in Vercel, open the project's Deployments, choose the last good deployment and select *Promote to Production* (instant, no rebuild).
- **Code:** `git revert <commit>` on a branch, open a pull request, merge after CI passes.
- **Data:** revert the bad `Data refresh …` commit the same way. The next scheduled refresh rebuilds from the sources; caches (`data/epochs.json`, `data/boundaries.json`) are validated by the integrity checks before anything is published.

## Reproduce a submission

The submission is tagged in Git. A tag pins the code, the committed dataset (`data/latest.json` with its `generated_at`), the daily snapshots in `data/snapshots/`, and THESIS.md. `node scripts/check-data.mjs` validates the dataset; `npm run build` rebuilds it from the sources (provider histories such as DefiLlama can be revised later, which is why the dated snapshots are kept).
