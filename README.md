# SmartifyOS CLI

The command line tool for [SmartifyOS](https://smartify-os.com/), the open source car infotainment system built in Flutter.

It does the complicated parts for you. You should never have to touch `flutter`, `git` or `adb` to build a system for your car.

> [!NOTE]
> This is early days. The tool creates your car's app, keeps its SmartifyOS and extensions up to date, puts it on a USB stick that sets up your car, helps you make your own extensions, and keeps itself up to date.

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
smartify-os setup
```

That gets your computer ready, see below. After it, `smartify-os` on its own shows everything it can do.

### Options

Set these before running the installer if you want something other than the defaults.

| Variable                     | What it does                                                            |
| ---------------------------- | ----------------------------------------------------------------------- |
| `SMARTIFY_OS_VERSION`        | Install a specific release, for example `v0.1.0`, instead of the newest |
| `SMARTIFY_OS_INSTALL_DIR`    | Install somewhere other than `~/.smartify-os/bin`                       |
| `SMARTIFY_OS_NO_MODIFY_PATH` | Leave your shell config alone                                           |
| `SMARTIFY_OS_BASE_URL`       | Download from a mirror instead of GitHub                                |

## Setting up your computer

```bash
smartify-os setup                      # install what SmartifyOS needs
smartify-os doctor                     # check what this computer has
```

SmartifyOS is built with Flutter, and `setup` installs it for you: the newest stable release, into `~/.smartify-os/tools/flutter`, out of your way. If you have Flutter already, that one is used and nothing is installed. `setup --platformio` also sets up PlatformIO, which builds the devices on your car's CAN bus (it otherwise sets itself up the first time you build one). Flutter needs git, and `setup` tells you how to get it if it is missing.

`doctor` checks everything, the way `flutter doctor` does, and says what to do about anything missing:

| Check                     | When it is missing                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------- |
| Flutter and git           | An error. SmartifyOS does nothing without them                                          |
| Xcode and CocoaPods, Visual Studio, or the Linux build tools | A warning. Only needed for `smartify-os run`, trying your car's app on this computer |
| PlatformIO                | A warning. Only needed for the devices on your car's CAN bus                            |
| Android platform tools    | A warning. Only needed if your setup works with Android devices                          |

It exits with 1 when there is an error, so a script can rely on it. With `--json` every check has an `id`, a `status` and what it found, and `fix` holds the arguments of the command that puts it right when there is one (`setup`, or `setup --platformio`).

## Starting your car

```bash
smartify-os create
```

It asks what your car is called, what car it is, how the screen should be laid out, which side the driver sits on, what goes in the bar along the edge, which time zone the car is in, whether you have a 3D model, a drawing or a picture of the car, and whether it has a reverse camera. Then it makes your car's app: a folder called `smartify_os_<name>_app`, made for the newest SmartifyOS, with your answers in `lib/main.dart`, where you can change them any time. It checks that the app builds and makes it a git repository, so it is ready to put on GitHub.

Every question can be answered with a flag instead, `smartify-os create --help` lists them:

```bash
smartify-os create "Golf 4" --car "Volkswagen Golf IV" --layout split --driver-side right
```

`--dry-run` only checks the answers and says where the app would go, without creating anything.

`smartify-os create --from miata` copies the Miata app instead, the example car with everything in it, to learn from. It is copied as it is, so you give it your car's name and the rest in its `lib/main.dart` yourself.

## Your car

Run these in your car's app folder, the one with `pubspec.yaml` in it.

```bash
smartify-os update                     # move your car to the newest SmartifyOS
smartify-os extension add <url>        # add an extension from its GitHub address
smartify-os extension update           # move your extensions to their newest releases
smartify-os extension remove <name>    # take one out again
smartify-os extension list             # what your car runs, and which versions
smartify-os run                        # try your car's app on this computer
```

Every one of them tries the change before it keeps it: it fetches the new versions and checks that your app and every extension still build. If anything does not, it puts everything back the way it was and tells you which extension is at fault. A new SmartifyOS that an extension has not caught up with yet is not a problem: the update offers that extension's newest release along with it, or leaves your car as it was when there is none.

Adding an extension also switches it on in `lib/main.dart` for you, and removing one takes it out again.

How your car looks and what its About page says can be changed any time, without opening `lib/main.dart`:

```bash
smartify-os appearance                 # the layout, theme, driver's side, bar and the car on screen
smartify-os appearance --model-3d ~/Downloads/golf.glb
smartify-os about                      # its name, what car it is, and rows like the VIN
smartify-os about --extra "VIN=WVWZZZ1JZXW000001"
```

Both write into `lib/main.dart` the way you would by hand, and leave alone anything you wrote there that they cannot read. A 3D model, drawing or picture is copied into your app's `assets` folder.

Everything else your app hands SmartifyOS in `lib/main.dart` (how the 3D model sits and which of its parts move, the info display, Bluetooth, the reverse camera and the rest) is a setting `config` reads and changes by its key, like `git config`:

```bash
smartify-os config                                  # everything that is set, the rest is the default
smartify-os config --list                           # every setting there is, with its default
smartify-os config car.model3D.scale 0.8
smartify-os config --set bluetooth.autoConnect=off --set reverseCamera.guides.carWidth=1.68
smartify-os config --unset car.model3D.scale        # back to SmartifyOS's own
smartify-os config --add layouts.hiddenLayouts=portrait
smartify-os config --add 'infoDisplay.values={"id":"rpm","label":"Engine speed","unit":"RPM"}'
smartify-os config --move 'infoDisplay.views[2]=0'  # an element of a list by its place
smartify-os config --remove 'car.model3D.parts.rollingWheels[3]'
```

A setting written as code it cannot read (a variable, say) is shown as code, and a change that would go inside it is printed for you to make by hand.

An extension's own settings, the arguments its class takes where `lib/main.dart` switches it on, work the same way. What each one is comes from the extension's code and its doc comments:

```bash
smartify-os extension settings voice_assistant                      # every setting, with its default
smartify-os extension settings voice_assistant wakeWord "Hey Miata"
smartify-os extension settings voice_assistant --unset duckLevel
smartify-os extension settings voice_assistant recognizer SpeechModels.whisperBase
smartify-os extension settings voice_assistant --set 'aiServer={"url":"http://192.168.1.20:11434/v1","model":"qwen3:8b"}'
smartify-os extension settings voice_assistant aiServer.model llama3
smartify-os extension settings android_auto --set 'wirelessNetwork={"$making":"existing","passphrase":"secret"}'
smartify-os extension settings voice_assistant --describe aiServer   # how a setting like that can be made
```

A list or map setting is changed an item at a time, each named in brackets: `--set 'voices[de]=SpeechModels.piperThorsten'`, `--unset 'voices[de]'`. A setting that is another class of the extension's has settings of its own, named with a dot. It is made with one of the ready-made ones its package has, or with one of its constructors (`$making` names a named one) and what that has to be given.

Your own windows, quick settings tiles and home screen widgets each start as a file the CLI makes for you, already handed to SmartifyOS in `lib/main.dart`. You only fill in what it shows or does:

```bash
smartify-os window create "Trip computer"     # a window, with its icon in the app list
smartify-os tile create "Interior light"      # a switch or button in the quick settings
smartify-os widget create "Oil temperature"   # a card or widget on the home screen
smartify-os window list                       # the ones your app has
smartify-os window edit "Trip computer" --icon speed --order 10
smartify-os window edit "Trip computer" --app-list off   # one your app opens itself
smartify-os window remove "Trip computer"
```

`list` also finds the ones you wrote yourself some other way, several in a list of your own say. Those are listed, but the CLI leaves changing them to you.

Settings pages of your own are made the same way, a row at a time. A switch or a choice keeps its value between drives, and the rest of your app reads it as `seatHeatingDriverSeat.value`. A button, or a switch you want to do something, runs a function of yours that starts out in the page's file:

```bash
smartify-os settings create "Seat heating" --in vehicle
smartify-os settings add-row "Seat heating" "Driver seat" --kind switch
smartify-os settings add-row "Seat heating" Level --kind choice --option Low --option High
smartify-os settings add-row "Seat heating" "Reset trip" --kind button
smartify-os settings edit-row "Seat heating" driver_seat --code on
smartify-os settings list
```

## Putting it on your car

SmartifyOS goes onto the car on a USB stick. Run these in your car's app folder too.

```bash
smartify-os export installer           # set up a new car
smartify-os export update              # update a car that runs SmartifyOS already
```

Both ask which USB stick to use (or take `--to <folder>`) and put a `smartify-os` folder on it. For a new car, install Debian 13 on it (Raspberry Pi OS Lite on a Raspberry Pi), plug the stick in, open it with `sudo mount /dev/sda1 /mnt` (there is no desktop to do that) and run `bash /mnt/smartify-os/install.sh` once. It asks for the password once, needs the internet, and leaves a car that starts straight into SmartifyOS, full screen, with no desktop or cursor. `README.txt` on the stick says the same. For an update, plug the stick into the car while SmartifyOS runs.

SmartifyOS is built one of two ways, picked with `--build-on`:

| `--build-on` | What happens                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `car`        | The stick gets your app's source, and the car installs Flutter and builds it. Works from any computer |
| `computer`   | This computer builds it in a Debian 13 container, and the car only gets the finished app. Needs [Docker Desktop](https://docs.docker.com/get-docker/) running (or Podman), or this computer to run Debian 13 itself |

Building on this computer asks what the car runs on, or takes `--arch arm64` (a Raspberry Pi) or `--arch x64` (a PC). A Linux build only starts on the Linux it was built on, which is why it is built in a container of the car's Linux. The first build sets the container up with Flutter and everything building needs, which takes a while. It is kept, stopped, so every build after it is quick. Building for the other architecture than this computer's runs emulated and takes a good deal longer. `docker rm -f smartify-os-builder-arm64` (or `-x64`) throws a container away, if you ever want the space back.

Whatever your car needs installed on Linux (a driver, a program an extension runs, a library to build against) is installed for you, worked out from SmartifyOS, every extension and your own app. Extensions list it in their `pubspec.yaml`, see "Linux packages" in `EXTENSIONS.md`. It all goes in as one package called `smartify-os-run` (and `smartify-os-build` on a car that builds itself), so whatever an extension stops needing is taken out again, and nothing you installed yourself is ever touched. Something that would take part of the car's system out to make room is left out, with a warning naming the extension that asked for it.

## Devices

The ESP32 boards around your car, on its CAN bus, run small Arduino programs. `DEVICES.md` in the [SmartifyOS repository](https://github.com/Mauznemo/smartify_os_flutter_test) is the full guide. Run these in your car's app folder, or in a device's folder.

```bash
smartify-os device create              # the program of one device, in devices/<name>/
smartify-os device create --usb        # the same for a board on a USB cable
smartify-os device flash               # build it and put it on its board, over USB
smartify-os device export              # new firmware for your devices on a USB stick, USB boards too
smartify-os device list                # the devices with a program, and their versions
smartify-os device edit dashboard --baud-rate 9600   # change a board on USB
```

A car with only one or two boards can leave the CAN bus out: a board on a USB cable (any ESP32, an Arduino Uno or Nano) talks to the car over serial. `device create --usb` puts it into your car's app as a `SerialDevice` in `lib/serial.dart` and its `SerialConfig`, and makes a plain Arduino sketch for it, with no library, that says which device it is when the car asks (`smartify-os:<name>`), so the car finds it on whichever port it is plugged into. `device export` puts its firmware on a stick too (every file esptool or avrdude writes, and a `.conf` with `CONNECTION=usb`), and the car writes it onto the board over its USB cable once the driver taps Update on the notification, with the esptool or avrdude the installer puts on the car.

The devices and their messages are defined in your car's app, and `smartify-os run` writes them out as `firmware/smartify_os_network.h` for the devices' programs. Building is done by [PlatformIO](https://platformio.org/), which the CLI installs by itself into `~/.smartify-os/tools` the first time, with a Python of its own, so there is nothing to install. The first build also downloads the ESP32 tools, which takes a few minutes. Every device is built against the SmartifyOS-ESP32 library release your car's SmartifyOS names, and gets the board's default partition table, which has room for updates over the bus.

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
| `output`         | A line printed by Flutter while `run` or `extension run` runs: `stream`, `text`            |
| `reply`          | The answer to a `call`: its `id`, `ok`, and `data` or an `error` saying why it did not work |
| `result`         | The end, see above                                                                         |

A `note` that says what to do next carries the same steps as `data.steps`, each with a `kind` (like `run` or `flash`), its `text`, and the `path` it is about when there is one, so a GUI can say each step its own way, with its buttons instead of the commands to type.

What a program can write to stdin, one JSON object per line:

| Message                        | What it does                                                          |
| ------------------------------ | --------------------------------------------------------------------- |
| `{"id":"p1","value":...}`      | Answers a prompt: `true`/`false`, a string, an option's `value`, or a list of them for `multiselect` |
| `{"value":...}`                | Answers the next question asked, for piping every answer in up front |
| `{"id":"p1","cancel":true}`    | Cancels, the same as Ctrl+C                                           |
| `{"input":"r"}`                | Types into Flutter while `run` or `extension run` runs, `r` to reload and `q` to stop |
| `{"call":"describe","id":"c1"}` | Asks the car's app something while `run` runs, see below              |

While `run` runs the car's app, `call` reaches SmartifyOS inside it, with `params` as an object when the call takes any. Every call gets a `reply` with the same `id`. They need a SmartifyOS that knows them, and a call made before the app is up says so in its `error`.

| Call        | What it does                                                                     |
| ----------- | -------------------------------------------------------------------------------- |
| `describe`  | What the app has: its `layouts`, `themes` and ways to draw the car, which of them it starts with and which is on screen, the `driverSide`, what is in the `bar`, the `about` page, every page of Settings a page of its own can go in (`settingsPages`), every extension by its class with what it added while it was set up (`extensions`, each kind as `{id, title}`), and which bigger configs `configure` can change while it runs (`live`) |
| `configure` | Changes what the car starts with, any of `layout`, `theme`, `driverSide`, `bar` (`infoDisplay`, `dock`, `infoDisplayAndDock`), `carLook` (`model3D`, `drawing2D`, `image`), `deviceName`, `model` and `extra` (an object), and the configs `live` names, as JSON: `model3D` (any of `scale`, `lookAtHeight`, `offset` and `rotation` as `{x, y, z}`, and `render` with `exposure`, `environmentIntensity` and `vignette`) and `infoDisplay` (`values`, `views` and `hiddenValues`, each whole). An empty string goes back to SmartifyOS's own. The driver's own pick of the same thing is forgotten, and the reply is the same as `describe`. It does not change `lib/main.dart`, `appearance` and `about` do that |
| `screenshot` | What is on screen, as a `png` in base64 with its `width` and `height` |
| `show`      | Puts something on screen the way the driver finds it: `kind` (`window`, `tile`, `widget` or `settings`) with its `id`. A window opens, the quick settings come down, a card comes back, a settings page opens |
| `canDescribe` | The car's CAN bus: its `devices` (`node`, `name`, `title`, whether it is `online`, and whether it is `pretending` for you) and `messages` (`id`, `name`, the `from` node that sends it, and its `fields` with their `kind` and limits) |
| `canSend` | Takes a message as if its device had sent it: `message` by name and `values` as an object by field name, choices by their names |
| `canDevice` | Makes the device with `node` say it is there, once a second, or stop with `there` set to `false` |
| `canTraffic` | What the app sent on the bus after number `after`, each of its `frames` with its `seq`, `message` and `values`, and the number the `next` one gets, which is lower than `after` once the app started again |
| `serialDescribe` | The car's boards on USB: its `devices` (`name`, `title`, `baudRate`, the `state` it is in (`searching`, `connected`, `failed`), the `port` of a real board it is on, a `problem`, whether it is `pretending` for you, the `values` the app listens for by name, whether it listens to every line (`lines`), and the `last` value of each name) |
| `serialSend` | Takes a `line` as if the board of the `device` (its name) printed it |
| `serialDevice` | Makes the `device` count as plugged in, connected to you rather than a board, or stop with `there` set to `false`. A device on a real board stays on it |
| `serialTraffic` | What the app sent to its boards after number `after`, a `line` each with its `seq` and `device`, and the number the `next` one gets |

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
git clone https://github.com/SmartifyOS/SmartifyOS-CLI.git
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
| `bun run release`       | Cut a release, for the maintainer. It asks for the version and a summary, writes the release notes from the commits and does the rest. `--dry-run` only shows it |

Set `SMARTIFY_OS_CORE_REPO` to another SmartifyOS repository, for example a local one as `file:///path/to/repo`, to try the car and extension commands against releases that are not published.

`install:dev` is the one to use while working on it. It installs to `~/.smartify-os/bin` just like the real installer, so you can run `smartify-os` from inside an actual car project, and your edits take effect straight away.
