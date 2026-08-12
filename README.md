# GlanceCalendar

**Even Hub app name:** Calendar with Gemini
**GitHub repository:** GlanceCalendar

This repository is the source for "Calendar with Gemini", a calendar application for
Even Realities G2 smart glasses. "GlanceCalendar" is the name of this repository;
"Calendar with Gemini" is the name the app is distributed under on Even Hub. They refer
to the same application.

## Overview

Calendar with Gemini lets a G2 wearer manage their Google Calendar by voice, from the
glasses, without a phone or laptop. Speech captured through the glasses microphone is
sent to a backend service, interpreted by Gemini, and turned into a calendar action:
checking upcoming events, creating a new event, or editing/deleting an existing one.

The app supports:

- Voice-driven event lookup and creation
- Viewing event details, editing, and deleting events
- All-day events and multi-day (date-range) events
- Japanese and English

This is a technical repository for an app under active development; it is not a
general-purpose calendar product.

## Features

- View today's events
- View tomorrow's events
- View upcoming events
- Create calendar events by voice
- View event details
- Edit events
- Delete events
- All-day event support
- Multi-day / date-range event support
- Japanese and English localization
- Locale-aware Gemini interpretation

## Architecture

```
Even G2 glasses
      │  microphone audio
      ▼
Even Hub Plugin (even-calendar-plugin)
      │  HTTPS (audio, requests)
      ▼
Cloud Run backend (even-calendar-agent)
      │                     │
      ▼                     ▼
   Gemini              Google Calendar API
(speech → structured   (event read/write,
 event/edit candidate)   via Google OAuth)
```

The glasses run the Even Hub plugin, which records audio and talks to a backend service
running on Cloud Run. The backend calls Gemini to turn speech into a structured
calendar-event candidate or edit instruction, and calls the Google Calendar API (via
Google OAuth) to read or write the user's calendar.

## Repository structure

- `even-calendar-agent/` — the backend service (TypeScript/Express, deployed to Cloud
  Run). Handles authentication, Gemini prompting/parsing, Google Calendar API calls,
  Firestore-backed session/candidate storage, and the `/plugin/*` HTTP API consumed by
  the plugin. See `even-calendar-agent/README.md` for backend-specific details.
- `even-calendar-plugin/` — the Even Hub plugin (TypeScript, built with Vite) that runs
  on the G2 glasses. Handles recording, screen rendering, and calling the backend API.
  See `even-calendar-plugin/README.md` for plugin-specific details.

## Requirements

- Node.js >= 20 (declared in `even-calendar-agent/package.json` `engines.node`)
- npm
- Even Hub CLI (`@evenrealities/evenhub-cli`, currently `^0.1.13` in
  `even-calendar-plugin/package.json`) — for packing/deploying the plugin
- Google Cloud CLI (`gcloud`) — for deploying the backend to Cloud Run

## Development / Build

Run these from within each project directory.

### `even-calendar-agent`

```
npm install
npx tsc -p tsconfig.json --noEmit   # type check
npm run lint
npm run test
npm run build                       # tsc -p tsconfig.json
```

### `even-calendar-plugin`

```
npm install
npx tsc --noEmit                    # type check
npm run lint
npm run test
npm run build                       # tsc --noEmit && vite build
npm run build:product               # tsc --noEmit && vite build --mode product
```

`build:product` produces the build used for packaging (see below): it points at the
production backend URL and excludes local developer session settings from the bundle.

## Packaging

The plugin is distributed to Even Hub as a `.ehpk` package, built from the
`build:product` output and `app.json` using the Even Hub CLI:

```
npm run build:product
npx evenhub pack app.json dist -o <output-file>.ehpk
```

(`package:product` in `even-calendar-plugin/package.json` wraps this into a single
command, but hardcodes an output filename tied to one specific version — check the
script before relying on it for a new release, or just run the two commands above with
the filename you want.)

## Configuration

The backend is configured via environment variables; see
`even-calendar-agent/.env.example` for the full list of names and a description of each
(all values there are placeholders, not real credentials). Configuration includes:

- A bearer token used to authenticate plugin requests
- Google OAuth client configuration (for Google Calendar access)
- The target Google Calendar / timezone
- The Firestore database used for session and candidate storage
- The name (not the value) of the Secret Manager secret holding the Calendar refresh
  token

In production, secret values (OAuth client secret, bearer tokens, refresh token, etc.)
are stored in Google Secret Manager and injected as environment variables at deploy
time — they are never committed to this repository. No secret values, tokens, or
`.env` contents should ever be added to this README or to source control.

## Permissions

The Even Hub plugin declares its permissions in `even-calendar-plugin/app.json`:

- `network` — to reach the backend for Gemini-based speech analysis and calendar
  operations
- `g2-microphone` — to record spoken calendar requests on the glasses

## Localization

The app supports Japanese (`ja`) and English (`en`):

- The plugin detects the active locale (from a stored setting, falling back to the
  browser/device locale) and sends it to the backend on relevant requests.
- The backend normalizes and propagates the locale into its Gemini prompts, so date/time
  parsing and generated messages match the requester's language.
- If no locale is sent, the backend defaults to Japanese, so older plugin builds keep
  working unchanged.

## Current release

- Version: `0.3.2`
- Package ID: `com.masaokster.calendarwithgemini`
- Languages: Japanese, English

For the exact current version and package ID, check `even-calendar-plugin/app.json` —
this section may not always be updated the moment a new version ships.

## Deployment

The backend (`even-calendar-agent`) runs as a Google Cloud Run service. The current
production service is `even-calendar-agent-probe` in the `asia-northeast1` region. Cloud
Run revision names change on every deploy and are not tracked here — check the Cloud Run
console/CLI for the currently active revision.

## Testing

Both projects are checked with:

- TypeScript compilation / type checking
- ESLint
- Unit/integration tests (Vitest)
- A production-mode build verification (`even-calendar-plugin`'s `build:product`, which
  also has dedicated tests asserting it never reads local developer session settings)

Test counts are not listed here since they change frequently as the project grows —
run `npm run test` in each project directory for the current results.

## Beta / production usage note

This app is intended to be distributed through the Even Realities Developer Portal. It
is not confirmed to be generally available there as of this writing. Using the calendar
features requires the user to complete Google OAuth authorization so the backend can
access their Google Calendar on their behalf.

## Privacy / Security

- Calendar data is only accessed after the user completes Google OAuth authorization.
- Microphone audio captured on the glasses is used only to fulfill the calendar request
  the user is actively making.
- OAuth client secrets, bearer tokens, and refresh tokens are managed in Google Secret
  Manager, outside of source control, and must never be committed to this repository.

## License

No license has been specified yet.

---

## 日本語での補足

本リポジトリは Even Realities G2 向けカレンダーアプリ「Calendar with Gemini」(GitHub 上のリポジトリ名は
GlanceCalendar)のソースです。グラサンのマイクで話しかけた内容を Gemini で解析し、Google Calendar
の予定確認・登録・編集・削除を行います。日本語・英語の両方に対応しています。詳細は各ディレクトリ
(`even-calendar-agent/README.md`, `even-calendar-plugin/README.md`)を参照してください。
