The command line tool for SmartifyOS, the open source car infotainment system built in Flutter.

Its whole job is to hide `flutter`, `git`, `adb` and the rest from the end user. Someone building a system for their car should be able to do everything through this tool without knowing any of those exist, so every command has to be friendly, forgiving and hard to get wrong. The Flutter side lives in the separate SmartifyOS repo, this repo is only the CLI.

## Tech stack

- **Bun** is the runtime, bundler, test runner and package manager. `bun build --compile` produces one standalone binary per platform, so users install nothing else.
- **TypeScript**, strict, with `noUncheckedIndexedAccess`.
- **@clack/prompts** for everything interactive. It has `spinner`, `progress`, `tasks`, `taskLog`, `group` and `box`, use them rather than writing your own.
- **picocolors** for color, always through `src/ui/theme.ts`.
- **Biome** for linting and formatting, `tsc --noEmit` for typechecking (Bun does not typecheck).
- Arguments are parsed with `parseArgs` from `node:util`, no dependency. Help output is rendered by hand in `src/cli.ts` so it matches the clack look.

Runtime dependencies are deliberately kept to two. Think before adding a third.

## Structure

```
src/index.ts        entry point, the only place that ends the process
src/cli.ts          parse() and run()
src/commands/       one file per command, switched on in commands/index.ts. A group
                    like `extension` has a folder, one file per subcommand
src/ui/             anything that talks to the terminal, including help rendering
src/core/           process runners, config, paths, the real work
src/utils/          small helpers with no opinion about the terminal
scripts/build.ts    cross compiles every target
```

Two rules keep the command imports going one way, and both exist because a `help` command
needs the help renderer while the help renderer needs the list of commands:

- **Commands are registered in `src/commands/index.ts`**, into the array that lives in
  `src/commands/registry.ts`. A command file imports `registry.ts`, never `index.ts`.
- **`src/ui/help.ts` takes the command list as an argument** and never imports the registry.

- **`src/core/` must never import `@clack/prompts`.** Logic stays testable without a TTY and reusable from a non interactive run. Only `src/ui/` and `src/commands/` touch the terminal.
- **Every command has to work non interactively.** Flags supply the answers, prompts only fill in what is missing. Prompting when nobody can answer throws instead of hanging, see `assertInteractive` in `src/ui/prompt.ts`.
- **Never call a clack prompt directly**, go through `src/ui/prompt.ts`. Those wrappers turn Ctrl+C into a `CancelledError` so no command has to check `isCancel` itself.
- **Never print with `console.log`**, use `writeLine` or the `log` helpers from `src/ui/output.ts`. Biome fails the build on `console`.
- **Failures throw `CliError`** from `src/utils/errors.ts` with a message saying what went wrong and a `hint` saying what to do about it. Commands return nothing on success, the exit code comes from the error.

## Naming commands

Nearly every command acts on the user's car project, so **the project is the default and never needs saying**. It is `build`, not `project build`, and `update` moves the project to a newer SmartifyOS.

Anything acting on the CLI instead is the exception and says so: `self-update`.

Commands about one kind of thing are grouped under it, `extension add`, `extension create`. A group is a `Command` with `subcommands`, and the parser, help and menu handle the rest.

## Changing a car's app

A car's `pubspec.yaml` names where SmartifyOS and every extension come from, under `dependency_overrides`, and that block is the CLI's (see `src/core/project/block.ts`). It is edited line by line with `src/core/pubspec/blocks.ts`, never parsed and written back, so the owner's comments survive.

**Every change to what a car runs goes through `tryChange`** in `src/core/project/change.ts`. Pub never checks an extension's SmartifyOS lower bound (the override hides it), so fetching and analyzing, and putting every file back on errors, is the only check there is. It analyzes each extension's `lib` with the app's `package_config.json`: `flutter analyze` on the app alone never reports errors inside a dependency.

## Writing style

- Never use em dashes (—) or en dashes (–), anywhere: not in UI strings, docs, normal comments, or markdown. Use a comma, parentheses, or a separate sentence instead. This is checked by `tests/dashes.test.ts`, which scans the whole repo and fails on either character.
- Spell the project name out in full, `SmartifyOS` or `smartify-os`, never `Smartify` on its own.

## Working on it

```bash
bun install
bun run check             # lint, typecheck, test, build. Run this before every push
bun run check:all         # the same plus all eight targets, worth it before a release
bun run dev -- --help     # run from source
bun run format            # Biome, fixes what it can
bun run build             # one binary for this machine, then runs it
bun run build:all         # all eight published targets
bun run install:dev       # put smartify-os on your PATH, running live from src
bun run install:local     # same, but the real compiled binary
```

**`bun run check` is the safety net, not GitHub.** CI only runs on pull requests, so nothing checks a push to main. The check takes about two seconds and reports every failure at once instead of stopping at the first, so there is no reason to skip it.

`install:dev` and `install:local` both install to `~/.smartify-os/bin` and add the same PATH line the real installer does, so they replace each other and a later `curl | bash` replaces them. Use `install:dev` while working, since it needs no rebuild, and `install:local` to check the thing a user actually gets.

Compiling to a standalone binary produces a format with no top level await, which is why `src/index.ts` calls `main().then(...)` instead of awaiting.

Three things about the compiled binary that were learned the hard way, all handled in `scripts/build.ts` and `src/index.ts`, do not undo them:

- `autoloadBunfig` and `autoloadDotenv` are turned **off**. They default to on, which makes the binary read a `bunfig.toml` and a `.env` out of whatever directory the user is standing in. An unrelated `bunfig.toml` stopped the CLI from starting at all.
- **No `bytecode`.** It saved 0.5 ms out of 43 ms on a bundle this small and is implicated in open Bun bugs around standalone binaries.
- A closed pipe (`smartify-os --help | head`) is not an error. See `ignoreClosedPipes` in `src/index.ts`.

Bun's musl binaries link against `libstdc++`, which Alpine does not ship. `install.sh` names it if it is missing.

`__BUILD_TARGET__` is injected the same way `__BUILD_SHA__` is, so `self-update` knows which of the eight builds to download without having to guess. Guessing gets glibc and musl the wrong way round, and that binary does not start at all. Anything else added to `define` needs a declaration in `globals.d.ts` and a `typeof x === 'string'` fallback for running from source.

Releases are cut by pushing a `v*` tag that matches the version in package.json. The release workflow runs lint, typecheck and tests first and stops if any of them fail, then builds every target, signs the macOS ones on a Mac, publishes them, and installs the result on Linux, macOS, Windows and Alpine to prove the install scripts still work.

## Keeping this file useful

Update this file when something here stops being true or when a new rule will matter in **every** later session. Do not clutter it with one off details or things that are easy to work out from the code. If something one off needs explaining, a doc comment is the right place.
