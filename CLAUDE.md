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
src/core/linux/     what a car needs installed on Linux, and scripts/, the shell that runs on it
src/core/device/    the ESP32s on a car's CAN bus: their projects, PlatformIO, the stick
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
- **Failures throw `CliError`** from `src/utils/errors.ts` with a message saying what went wrong and a `hint` saying what to do about it. The exit code comes from the error.
- **Every command has to work under `--json`**, which is how the GUI and AI agents drive the CLI (the protocol is in README.md and `src/ui/json.ts`). A command returns what it did as a plain object, which becomes `result.data`: every return, "nothing was changed" included, with a shape that stays stable. The wrappers in `src/ui/output.ts` and `src/ui/prompt.ts` already turn everything on screen into events. A clack function that is not wrapped there yet gets a wrapper with a JSON branch before a command uses it.

## Naming commands

Nearly every command acts on the user's car project, so **the project is the default and never needs saying**. It is `build`, not `project build`, and `update` moves the project to a newer SmartifyOS.

Anything acting on the CLI instead is the exception and says so: `self-update`.

Commands about one kind of thing are grouped under it, `extension add`, `extension create`. A group is a `Command` with `subcommands`, and the parser, help and menu handle the rest.

## Changing a car's app

A car's `pubspec.yaml` names where SmartifyOS and every extension come from, under `dependency_overrides`, and that block is the CLI's (see `src/core/project/block.ts`). It is edited line by line with `src/core/pubspec/blocks.ts`, never parsed and written back, so the owner's comments survive.

**Every change to what a car runs goes through `tryChange`** in `src/core/project/change.ts`. Pub never checks an extension's SmartifyOS lower bound (the override hides it), so fetching and analyzing, and putting every file back on errors, is the only check there is. It analyzes each extension's `lib` with the app's `package_config.json`: `flutter analyze` on the app alone never reports errors inside a dependency.

**How a car looks and its About page** (`appearance`, `about`) are arguments in `lib/main.dart` too, read and written by `src/core/project/appearance.ts`. A setting written as code the CLI cannot read is reported in `code` and never guessed at, a config that is missing is added where nothing is in the way, and a commented out example of an argument (`// look: CarLook.drawing2D,`) is uncommented rather than repeated. `lib/main.dart` is run through `dart format` afterwards only when it was formatted before.

**Windows, quick settings tiles and home screen widgets** (`window`, `tile`, `widget`) are each a file the CLI writes in a folder of its kind (`lib/windows/`, `lib/quick_settings/`, `lib/home_widgets/`), handed to SmartifyOS in a list in `lib/main.dart`, all in `src/core/project/parts.ts`. It reads them back, renames them and changes their icon by the shape it wrote them in, so a change to the templates there has to keep `readPart` reading them. The icons offered are a copy in the editor (`src/lib/parts.ts`), drawn there with the closest Lucide icon.

**Settings pages** (`settings`) are files in `lib/settings/`, read and changed by `src/core/project/settings.ts` one row at a time: each row is an element of the page's `entries` list, edited in place, so code the owner wrote inside a row or anywhere else in the file stays. A row that remembers its value gets a `SavedValue` declared further down, named after the page and row, and one that runs code gets a stub function. Taking either away again only deletes the stub if the owner wrote nothing in it, and the `SavedValue` if no other file reads it.

**The running app** is reached while `run --json` runs it: `{"call": ...}` on stdin goes to the Dart VM service `flutter run` prints (`src/core/vm-service.ts`), to the service extensions SmartifyOS registers in a debug build (`EditorBridge` in core), and every call gets a `reply` event. That is how the editor changes the app live.

## Creating a car

`create` copies `smartify_os_app_template/` out of the SmartifyOS repo at the newest release, renames `my_car` and `My car`, and writes the owner's answers into its `lib/main.dart` as named arguments of the calls the template makes (`setUpMain` in `src/core/project/create.ts`). An answer whose call is not found is printed for the owner to add, never a failure. The layouts it offers are a copy of `Layouts` in core, so a new built-in layout is a change here too (and in the editor's new car dialog). `--dry-run` checks the answers and returns where the app would go, which the editor uses to check each page. `--from miata` copies the Miata app as it is, only its pubspec is pointed at SmartifyOS.

## What runs on the car

`export installer` and `export update` put a `smartify-os` folder on a USB stick (layout in `src/core/export/export.ts`). What runs on the car is shell, in `src/core/linux/scripts/`, embedded in the binary as text. **`linux.sh` is the one step** every install, build on a car, build for a car and (later) update on the car runs, so there is never a second way of doing it. It installs a package set as one generated `.deb`, stateless every time. The CLI checks and merges the lists, the script only carries them out.

`linux.sh system` is the base setup that makes a computer a car: the service that starts SmartifyOS in labwc on tty1 and again whenever it quits, passwordless sudo, the udisks2 polkit rule, the `video` group (the reverse camera), no cursor, a quiet boot. It is in `linux.sh` rather than `install.sh` so an update can run it too, and what it needs installed is `carSystem` in `src/core/linux/set.ts`, in the run set, so every update keeps it. `install.sh` draws itself like clack and runs every step with stdin from `/dev/null`: apt puts a terminal it is given into raw mode, which breaks the drawing.

A new version only ever replaces `DIR/app` by being made complete as `DIR/app.new` and then two renames (`app` to `app.old`, `app.new` to `app`), in `install.sh` and in core's `LinuxUpdateBackend` alike. The service's `before-start` (`system_before_start` in `linux.sh`) relies on exactly that to put right a power cut halfway and to go back from a version that never lasts a minute. Every export carries a `SHA256SUMS` that both check before anything on the stick runs.

The scripts have to run under the bash 3.2 macOS ships, so `bun test` can run them against the stub apt in `linux.test.ts`: no associative arrays, no `mapfile`. Never `cmd | grep -q` under `pipefail` (grep exits early, the writer dies of SIGPIPE, a match becomes a failure), use a here-string.

The official Linux is named in one place, `src/core/linux/distro.ts`: Debian 13, and Raspberry Pi OS Lite on a Pi, which reports itself as Debian 13 (why is in `LINUX_SYSTEM.md` in the SmartifyOS repo). Building for a car on another computer happens in a kept container of that image, set up with the same `linux.sh` steps a car runs (`src/core/export/container.ts`), never with a Dockerfile of its own.

## Flutter on the owner's computer

`smartify-os setup` installs the newest stable Flutter into `~/.smartify-os/tools/flutter` (`src/core/setup/flutter.ts`), cloned at its tag the way `linux.sh flutter` does it on a car. Unlike PlatformIO it is only a fallback: `findFlutter` in `src/core/process.ts` takes a Flutter on PATH first, and `setup` never installs a second one next to it. `doctor` (`src/core/setup/doctor.ts`) fails only on what nothing works without (Flutter, git), everything else is a warning saying what it is for.

## The devices on a car's CAN bus

`smartify-os device` makes, builds and exports the firmware of the ESP32s on a car's bus (`DEVICES.md` in the SmartifyOS repo is the owner's guide). Each is a PlatformIO project in `<app>/devices/<name>/`, built against the header core writes into `<app>/firmware/` while `smartify-os run` runs the app, and against the library and platform under `smartify_os: firmware:` in core's pubspec, which `syncIni` puts back into `platformio.ini` before every build. The version lives in the device's `smartify-os.json` and goes in as `PLATFORMIO_BUILD_FLAGS`, never in the owner's code.

PlatformIO is never looked for on PATH. `src/core/device/platformio.ts` installs it with uv into `~/.smartify-os/tools`, both pinned there, uv with its checksums written into that file: moving either on is a change to it. Every export moves a `devices/` folder already on the stick over into the new one, since `device export` can come first.

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
bun run release           # cut a release (scripts/release.ts), --dry-run to only look
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

Releases are cut with `bun run release` and nothing else. It checks the repo (on main, nothing uncommitted, up to date, `bun run check` passing), asks for the version and an optional summary, bumps package.json in a `chore: release vX` commit, and pushes a `vX` tag whose message is the release notes: the `feat:`, `fix:` and `refactor:` commits since the last tag. The release workflow publishes that message as the notes. The same script is in SmartifyOS-Editor; keep the two alike. The release workflow runs lint, typecheck and tests first and stops if any of them fail, then builds every target, signs the macOS ones on a Mac, publishes them, and installs the result on Linux, macOS, Windows and Alpine to prove the install scripts still work.

## Keeping this file useful

Update this file when something here stops being true or when a new rule will matter in **every** later session. Do not clutter it with one off details or things that are easy to work out from the code. If something one off needs explaining, a doc comment is the right place.
