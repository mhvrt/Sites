# Security and data boundaries

## Keep private

Store these values only as GitHub Actions secrets or in the private reports repository:

- target and source URLs;
- GitHub access tokens and Cloudflare credentials;
- raw JSON reports and `ip-history.csv`;
- full referrer, final URL, route history, page titles, and error details;
- visitor IP, location, ASN, and full user agent;
- screenshots, videos, Playwright traces, HAR files, console logs, and network logs;
- cookies, local storage, session storage, and Playwright storage-state files;
- analytics identifiers or exports that can be correlated with a private run.

## Safe to keep public

- generic Playwright navigation code;
- browser and device profile definitions;
- workflow schedules;
- validation scripts;
- anonymized run status, browser profile, page count, and duration;
- documentation explaining how to configure a private destination.

## Token scope

Use a fine-grained personal access token restricted to one private repository. Grant only Metadata read and Contents read/write. Do not use an account-wide classic token.

## Pull requests

The scheduled workflow does not run on `pull_request`, and GitHub does not provide repository secrets to workflows from forked pull requests. Review all changes before merging because code on the default branch can access configured secrets during scheduled runs.

## Runtime files

Detailed reports are written to the runner temporary directory with restrictive file permissions, sent to the private repository, and removed at the end of the job. They are not uploaded as public artifacts.
