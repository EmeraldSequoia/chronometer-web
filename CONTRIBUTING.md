# Contributing

Thanks for your interest in Emerald Chronometer & Observatory for the Web.

The project is in **maintenance mode**: it is essentially feature-complete, and the developers (who are volunteers) are focused on fixing bugs. No support or response time is promised, but reports are read and most bugs get fixed.

## Reporting a bug

**You don't need to write any code to help.** A clear bug report is the most useful thing you can send.

Please [open an issue](https://github.com/EmeraldSequoia/chronometer-web/issues/new/choose) and include as much of the following as you can:

- What you saw, and what you expected to see
- Which app (Chronometer, Observatory, Inspector, or the eclipse table), and which watch face if relevant
- Your browser and device (e.g. "Safari on iPhone 15", "Chrome on Windows 11")
- The app's version number (e.g. "v2.1.8"), shown at the bottom of the help popup opened by the ⓘ button (on the eclipse table, at the bottom of the page)
- The page URL, or the location and date/time you had set, if the problem depends on them
- A screenshot, if it helps show the problem

Don't worry if you can't supply all of this — a partial report is still welcome.

## Feature requests

Suggestions are welcome, but please understand that the bar for new features is now high and most won't be implemented. Small changes that fix something confusing or broken are the most likely to happen.

## Contributing code

Pull requests are welcome, but **please open an issue first** and discuss the change in its comment thread before you start implementing. That saves you from putting work into something that might not be merged — the project has some strong constraints that aren't obvious from the outside.

Before writing code, please read:

- [docs/development-rules.md](docs/development-rules.md) — the project's invariants (for example, the astronomical algorithms are faithful ports of the iOS code and must never be "simplified")
- [README.md](README.md#building-from-source) — how to build and run the apps
- [docs/README.md](docs/README.md) — the subsystem reference docs

A pull request should:

- Link to the issue where the change was discussed
- Pass `npx tsc --noEmit` and `npx vitest run`
- Keep the relevant docs up to date

By contributing, you agree that your contributions will be licensed under the project's [MIT license](README.md#license).
