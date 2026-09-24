# SmartifyOS CLI

The command line tool for [SmartifyOS](https://smartify-os.com/), the open source car infotainment system built in Flutter.

It does the complicated parts for you. You should never have to touch `flutter`, `git` or `adb` to build a system for your car.

> [!NOTE]
> This is early days. The tool keeps your car's SmartifyOS and extensions up to date, helps you make your own extensions, and keeps itself up to date. The commands for setting up and building a car system are still on their way.

## Install

**macOS and Linux**

```bash
curl -fsSL https://smartify-os.com/install.sh | bash
```

**Windows**

```powershell
irm https://smartify-os.com/install.ps1 | iex
```

Nothing else is needed, no Node, no Bun, no package manager. The installer downloads a single file, checks it against its published checksum, puts it in your home folder and adds it to your PATH. It never asks for sudo or administrator rights.

Then open a new terminal and run:

```bash
smartify-os
```

### Options

Set these before running the installer if you want something other than the defaults.

| Variable                     | What it does                                                            |
| ---------------------------- | ----------------------------------------------------------------------- |
| `SMARTIFY_OS_VERSION`        | Install a specific release, for example `v0.1.0`, instead of the newest |
| `SMARTIFY_OS_INSTALL_DIR`    | Install somewhere other than `~/.smartify-os/bin`                       |
| `SMARTIFY_OS_NO_MODIFY_PATH` | Leave your shell config alone                                           |
| `SMARTIFY_OS_BASE_URL`       | Download from a mirror instead of GitHub                                |

## Your car

Run these in your car's app folder, the one with `pubspec.yaml` in it.

```bash
smartify-os update                     # move your car to the newest SmartifyOS
smartify-os extension add <url>        # add an extension from its GitHub address
smartify-os extension update           # move your extensions to their newest releases
smartify-os extension remove <name>    # take one out again
smartify-os extension list             # what your car runs, and which versions
```

Every one of them tries the change before it keeps it: it fetches the new versions and checks that your app and every extension still build. If anything does not, it puts everything back the way it was and tells you which extension is at fault. A new SmartifyOS that an extension has not caught up with yet is not a problem: the update offers that extension's newest release along with it, or leaves your car as it was when there is none.

Adding an extension also switches it on in `lib/main.dart` for you, and removing one takes it out again.

## Making an extension

```bash
smartify-os extension create           # a new extension, with tests and an example app
smartify-os extension run              # try it in SmartifyOS on this computer
smartify-os link ../smartify_os_dashcam  # try it in your own car, from your car's app folder
smartify-os unlink                     # and back to the released versions
smartify-os extension release          # release a new version, so cars can update to it
```

`EXTENSIONS.md` in the [SmartifyOS repository](https://github.com/Mauznemo/smartify_os_flutter_test) is the full guide.

## Keeping it up to date

```bash
smartify-os self-update
```

That is all there is to it. It downloads the newest version, checks it against its published checksum, runs it to make sure it works on your machine, and only then replaces the one you have. If anything at all goes wrong along the way it says so and leaves your working copy exactly where it was.

```bash
smartify-os self-update --check      # only tell me whether there is a newer one
smartify-os self-update --to 0.2.0   # install one particular version
```

You do not have to remember to check. Once a day, after whatever you were doing has finished, SmartifyOS quietly asks GitHub whether there is anything newer, and mentions it if there is:

```
  › A newer SmartifyOS CLI version is out: 0.1.1 › 0.2.0
    Run smartify-os self-update to get it, it takes a few seconds.
```

The answer is remembered for 24 hours, so running ten commands in an afternoon is one check, not ten. The notice never appears in a script, in a pipe or in CI, and it goes to the error stream, so it can never end up in the middle of output you are using for something else.

| Variable                      | What it does                             |
| ----------------------------- | ---------------------------------------- |
| `SMARTIFY_OS_NO_UPDATE_CHECK` | Never check, never mention it             |
| `NO_UPDATE_NOTIFIER`          | The same, and respected by other tools too |

### Uninstall

```bash
rm -rf ~/.smartify-os
```

Then take the `export PATH` line back out of your shell config. It is the one marked `# added by the SmartifyOS installer`.

## Using it from a program

Every command takes `--json`, which is how a GUI or an AI agent drives the CLI. With it, stdout carries one JSON object per line, and nothing else goes to stdout or stderr. Questions are answered by writing JSON lines to stdin, so a program can do everything a person in the terminal can.

```bash
smartify-os extension remove dashcam --json
```

```
{"type":"start","protocol":1,"version":"0.1.1","sha":"a1b2c3d","command":"extension remove"}
{"type":"log","level":"intro","text":"Remove an extension"}
{"type":"step","id":"s1","status":"start","text":"Reading your car"}
{"type":"step","id":"s1","status":"done","text":"Your car runs SmartifyOS 0.2.0, with 1 extension"}
{"type":"prompt","id":"p1","kind":"confirm","message":"Take Dashcam out of your car?","initialValue":true}
                                    ← stdin: {"id":"p1","value":true}
{"type":"step","id":"s2","status":"start","text":"Taking Dashcam out"}
...
{"type":"result","ok":true,"exitCode":0,"data":{"changed":true,"extension":{"name":"smartify_os_dashcam",...}}}
```

The first line is always `start`. The last line is always `result`, which carries what the command did as `data`, or on failure an `error` with `kind` (`user`, `bug` or `cancelled`), `message`, `hint` and, when there is more to say, `details`. For example, `details` holds every build error when a change did not fit. The exit code is the same as without `--json`.

| Event            | What it is                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `start`          | `protocol`, `version`, `sha`, and the `command` that runs                                  |
| `log`            | A line for the user: `level` (`info`, `warn`, `error`, `success`, `message`, `intro`, `outro`, `note`), `text`, and sometimes `title` or `data` |
| `text`           | A line of plain output                                                                     |
| `step`           | Something being worked on: `id`, `status` (`start`, `update`, `done`, `error`), `text`       |
| `prompt`         | A question: `id`, `kind` (`text`, `password`, `confirm`, `select`, `multiselect`), `message`, and `options`, `initialValue` or `placeholder` when it has them |
| `prompt-invalid` | The answer to prompt `id` was refused, `message` says why, and the question is still open  |
| `output`         | A line printed by Flutter while `extension run` runs: `stream`, `text`                     |
| `result`         | The end, see above                                                                         |

What a program can write to stdin, one JSON object per line:

| Message                        | What it does                                                          |
| ------------------------------ | --------------------------------------------------------------------- |
| `{"id":"p1","value":...}`      | Answers a prompt: `true`/`false`, a string, an option's `value`, or a list of them for `multiselect` |
| `{"value":...}`                | Answers the next question asked, for piping every answer in up front |
| `{"id":"p1","cancel":true}`    | Cancels, the same as Ctrl+C                                           |
| `{"input":"r"}`                | Types into Flutter while `extension run` runs, `r` to reload and `q` to stop |

When stdin ends while a question is open, the command fails and puts the question in `error.details.prompt`, so a program that answered nothing learns what it has to pass as a flag. `--yes` skips every question that has a sensible answer already.

`smartify-os --help --json` describes every command, with its flags and subcommands, and `smartify-os <command> --help --json` describes one. That is enough to build a form for any of them.

## Supported platforms

| System  | Builds                                           |
| ------- | ------------------------------------------------ |
| macOS   | Apple Silicon, Intel                             |
| Linux   | x64, ARM64, and musl versions of both for Alpine |
| Windows | x64, ARM64                                       |

On Alpine and other musl systems you also need `libstdc++`, which Alpine does not ship by default:

```bash
apk add libstdc++
```

The installer tells you this by name if it is missing. Every other system already has what it needs.

## Working on the CLI

You need [Bun](https://bun.sh). Everything else comes from `bun install`.

```bash
git clone https://github.com/Mauznemo/SmartifyOS-CLI.git
cd SmartifyOS-CLI
bun install
```

| Command                 | What it does                                 |
| ----------------------- | -------------------------------------------- |
| `bun run check`         | Lint, typecheck, test and build, all in one. Run this before pushing |
| `bun run dev -- --help` | Run it from source                           |
| `bun test`              | Run the tests                                |
| `bun run typecheck`     | Typecheck with tsc                           |
| `bun run format`        | Format and fix with Biome                    |
| `bun run build`         | Build a binary for this machine, then run it |
| `bun run build:all`     | Build all eight published targets            |
| `bun run install:dev`   | Put `smartify-os` on your PATH, running live from source with no rebuild |
| `bun run install:local` | Same, but installs the real compiled binary  |

Set `SMARTIFY_OS_CORE_REPO` to another SmartifyOS repository, for example a local one as `file:///path/to/repo`, to try the car and extension commands against releases that are not published.

`install:dev` is the one to use while working on it. It installs to `~/.smartify-os/bin` just like the real installer, so you can run `smartify-os` from inside an actual car project, and your edits take effect straight away.
