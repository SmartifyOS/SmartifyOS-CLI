import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * linux.sh against a pretend Debian: `dpkg`, `dpkg-query`, `apt-cache`, `apt-get`,
 * `dpkg-deb` and `sudo` are small scripts acting out what the real ones would, from a few
 * files. That is enough to check every decision the script makes (what is missing, what
 * is left out and why, what goes into the generated package) on any machine. Whether apt
 * then does its part is only proven on the real thing.
 */

const script = join(import.meta.dir, 'linux.sh');
const root = await mkdtemp(join(tmpdir(), 'smartify-os-linux-sh-'));
/** The pretend system's state, the `FAKE` folder the stubs read and write. */
const fake = join(root, 'fake');
const bin = join(root, 'bin');
const set = join(root, 'set');

const stubs: Record<string, string> = {
	dpkg: `#!/bin/sh
[ "$1" = --print-architecture ] && { echo "\${FAKE_ARCH:-amd64}"; exit 0; }
exit 1
`,
	'dpkg-query': `#!/bin/sh
[ "$1" = -W ] || exit 1
format=$2; shift 2
for p in "$@"; do
	grep -qx "$p" "$FAKE/installed" || continue
	case "$format" in
	*Status-Abbrev*) printf 'ii \\t%s\\n' "$p" ;;
	*Version*) printf '1.5' ;;
	esac
done
exit 0
`,
	'apt-cache': `#!/bin/sh
[ "$1" = policy ] || exit 1
shift
for p in "$@"; do
	grep -qx "$p" "$FAKE/known" && printf '%s:\\n  Installed: (none)\\n  Candidate: 1.0\\n  Version table:\\n' "$p"
done
exit 0
`,
	'apt-get': `#!/usr/bin/env bash
echo "apt-get $*" >>"$FAKE/log"
case "$1" in
update)
	[ -n "\${FAKE_OFFLINE:-}" ] && echo "W: Failed to fetch http://deb.debian.org/debian/dists/trixie/InRelease  Temporary failure resolving 'deb.debian.org'"
	exit 0
	;;
autoremove) exit 0 ;;
install) ;;
*) exit 1 ;;
esac
simulate=0
for arg in "$@"; do [ "$arg" = -s ] && simulate=1; target=$arg; done
if [[ "$target" == *.deb ]]; then
	deps=$(sed -n 's/^Depends: //p' "$FAKE/last-control" | tr ',' '\\n' | tr -d ' ')
else
	deps=$target
fi
for dep in $deps; do
	victim=$(awk -F'\\t' -v p="$dep" '$1 == p { print $2 }' "$FAKE/removes")
	[ -n "$victim" ] && echo "Remv $victim [1.0]"
	grep -qx "$dep" "$FAKE/installed" || echo "Inst $dep (1.0)"
done
if [ "$simulate" = 0 ]; then
	printf '%s\\n' $deps >>"$FAKE/installed"
	cp "$FAKE/last-control" "$FAKE/installed-control"
fi
exit 0
`,
	'dpkg-deb': `#!/bin/sh
# dpkg-deb --build --root-owner-group <dir> <out>
rm -rf "$FAKE/last-pkg"
cp -R "$3" "$FAKE/last-pkg"
cp "$3/DEBIAN/control" "$FAKE/last-control"
touch "$4"
`,
	sudo: `#!/bin/sh
[ "$1" = -n ] && shift
exec "$@"
`,
	groupadd: `#!/bin/sh
echo "groupadd $*" >>"$FAKE/log"
`,
	usermod: `#!/bin/sh
echo "usermod $*" >>"$FAKE/log"
`,
	clang: `#!/bin/sh
echo 'Selected GCC installation: /usr/lib/gcc/x86_64-linux-gnu/14' >&2
`,
	systemctl: `#!/bin/sh
echo "systemctl $*" >>"$FAKE/log"
case "$*" in *get-default*) echo multi-user.target ;; esac
exit 0
`,
	visudo: `#!/bin/sh
echo "visudo $*" >>"$FAKE/log"
exit "\${FAKE_VISUDO:-0}"
`,
	'update-grub': `#!/bin/sh
echo "update-grub" >>"$FAKE/log"
`,
	'glib-compile-schemas': `#!/bin/sh
echo "glib-compile-schemas $*" >>"$FAKE/log"
`,
};

for (const [name, text] of Object.entries(stubs)) {
	await Bun.write(join(bin, name), text);
	await chmod(join(bin, name), 0o755);
}

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

interface System {
	installed?: string[];
	known?: string[];
	/** Installing the first of each pair takes the second out. */
	removes?: [string, string][];
}

async function system({ installed = [], known = [], removes = [] }: System): Promise<void> {
	await rm(fake, { recursive: true, force: true });
	await mkdir(fake, { recursive: true });
	await Bun.write(join(fake, 'installed'), installed.map((p) => `${p}\n`).join(''));
	await Bun.write(join(fake, 'known'), known.map((p) => `${p}\n`).join(''));
	await Bun.write(join(fake, 'removes'), removes.map((pair) => `${pair.join('\t')}\n`).join(''));
	await Bun.write(join(fake, 'log'), '');
}

interface SetFiles {
	apt?: string[];
	groups?: string[];
	udev?: Record<string, string>;
	toolchain?: boolean;
}

async function writeSet({ apt = [], groups = [], udev = {}, toolchain = false }: SetFiles) {
	await rm(set, { recursive: true, force: true });
	await Bun.write(
		join(set, 'set.conf'),
		`NAME=smartify-os-run\nDESCRIPTION=SmartifyOS\nFLUTTER_TOOLCHAIN=${toolchain ? 1 : 0}\n`,
	);
	await Bun.write(join(set, 'apt.list'), `# header\n${apt.map((l) => `${l}\n`).join('')}`);
	await Bun.write(join(set, 'groups.list'), groups.map((l) => `${l}\n`).join(''));
	await Bun.write(
		join(set, 'udev.list'),
		Object.keys(udev)
			.map((name) => `${name}\tDashcam\n`)
			.join(''),
	);
	for (const [name, text] of Object.entries(udev)) await Bun.write(join(set, 'udev', name), text);
}

function linuxSh(args: string[]) {
	const result = Bun.spawnSync(['bash', script, ...args], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, NO_COLOR: '1' },
	});
	return {
		code: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

async function read(name: string): Promise<string> {
	const file = Bun.file(join(fake, name));
	return (await file.exists()) ? await file.text() : '';
}

async function depends(): Promise<string> {
	return /^Depends: (.*)$/m.exec(await read('last-control'))?.[1] ?? '';
}

beforeEach(async () => {
	await system({});
});

describe('linux.sh', () => {
	test('is valid bash, and so is install.sh', () => {
		for (const file of ['linux.sh', 'install.sh']) {
			const result = Bun.spawnSync(['bash', '-n', join(import.meta.dir, file)]);
			expect(result.stderr.toString()).toBe('');
			expect(result.exitCode).toBe(0);
		}
	});

	test('installs what is missing as one package, for this architecture only', async () => {
		await system({ known: ['bluez', 'intel-media-va-driver', 'arm-only'] });
		await writeSet({
			apt: ['bluez\t*\tSmartifyOS', 'intel-media-va-driver\tx64\tDashcam', 'arm-only\tarm64\tX'],
		});
		const { code, stderr } = linuxSh(['packages', set]);
		expect(stderr).toContain('For SmartifyOS: bluez');
		expect(stderr).toContain('For Dashcam: intel-media-va-driver');
		expect(code).toBe(0);
		expect(await depends()).toBe('bluez, intel-media-va-driver');
		expect(await read('log')).toContain('apt-get install -y -q');
	});

	test('leaves out a package this Linux does not have, saying whose it is', async () => {
		await system({ known: ['bluez'] });
		await writeSet({ apt: ['bluez\t*\tSmartifyOS', 'blueez\t*\tDashcam'] });
		const { code, stderr } = linuxSh(['packages', set]);
		expect({ code, stderr }).toMatchObject({ code: 0 });
		expect(stderr).toContain(
			'Dashcam needs blueez, which this Linux does not have. Update Dashcam, or tell its author.',
		);
		expect(await depends()).toBe('bluez');
		expect(
			await Bun.file(join(fake, 'last-pkg/usr/share/smartify-os/smartify-os-run/skipped')).text(),
		).toBe('blueez\tDashcam\n');
	});

	test('asks for nothing when everything is there already', async () => {
		await system({ installed: ['bluez'], known: ['bluez'] });
		await writeSet({ apt: ['bluez\t*\tSmartifyOS'] });
		const { code, stderr } = linuxSh(['packages', set]);
		expect({ code, stderr }).toMatchObject({ code: 0 });
		expect(stderr).toContain('Everything SmartifyOS needs is installed already');
		expect(await read('log')).toBe('');
	});

	test('never takes anything out of the machine to make room', async () => {
		await system({ known: ['bluez', 'pulseaudio'], removes: [['pulseaudio', 'pipewire']] });
		await writeSet({ apt: ['bluez\t*\tSmartifyOS', 'pulseaudio\t*\tNoisy'] });
		const { code, stderr } = linuxSh(['packages', set]);
		expect({ code, stderr }).toMatchObject({ code: 0 });
		expect(stderr).toContain(
			'Noisy needs pulseaudio, which would take pipewire out of this machine.',
		);
		expect(await depends()).toBe('bluez');
	});

	test('carries the udev rules in the package, and reloads udev when they change', async () => {
		await system({ known: [] });
		await writeSet({ udev: { '70-smartify_os_dashcam-dashcam.rules': 'MODE="0660"\n' } });
		const { code, stderr } = linuxSh(['packages', set]);
		expect({ code, stderr }).toMatchObject({ code: 0 });
		expect(stderr).toContain('unplug it and plug it back in');
		expect(
			await Bun.file(
				join(fake, 'last-pkg/usr/lib/udev/rules.d/70-smartify_os_dashcam-dashcam.rules'),
			).text(),
		).toBe('MODE="0660"\n');
		expect(await Bun.file(join(fake, 'last-pkg/DEBIAN/postinst')).text()).toContain(
			'udevadm control --reload-rules',
		);
	});

	test('refuses a rule file name that could be a path', async () => {
		await writeSet({ udev: { '70-ok.rules': 'MODE="0660"\n' } });
		await Bun.write(join(set, 'udev.list'), '../../etc/passwd\tEvil\n70-ok.rules\tDashcam\n');
		const { code, stderr } = linuxSh(['packages', set]);
		expect({ code, stderr }).toMatchObject({ code: 0 });
		expect(stderr).toContain('The udev rule ../../etc/passwd of Evil cannot be used.');
	});

	test('adds the user to the groups the set lists', async () => {
		const user = userInfo().username;
		await writeSet({ groups: ['smartifyostestgroup\tDashcam'] });
		const { code, stderr } = linuxSh(['packages', set, '--user', user]);
		expect({ code, stderr }).toMatchObject({ code: 0 });
		expect(stderr).toContain(`${user} joined the groups smartifyostestgroup`);
		const log = await read('log');
		expect(log).toContain('groupadd -f smartifyostestgroup');
		expect(log).toContain(`usermod -aG smartifyostestgroup ${user}`);
	});

	test('adds the libstdc++ clang builds against to what building needs', async () => {
		await system({ known: ['clang', 'libstdc++-14-dev'] });
		await writeSet({ apt: ['clang\t*\tFlutter'], toolchain: true });
		const { code, stderr } = linuxSh(['packages', set]);
		expect({ code, stderr }).toMatchObject({ code: 0 });
		expect(await depends()).toBe('clang, libstdc++-14-dev');
	});

	test('says it needs the internet when apt cannot reach it, which apt itself only warns about', async () => {
		await system({ known: ['bluez'] });
		await writeSet({ apt: ['bluez\t*\tSmartifyOS'] });
		const result = Bun.spawnSync(['bash', script, 'packages', set], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, FAKE_OFFLINE: '1' },
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain('  x The package lists could not be updated.\n');
		expect(result.stderr.toString()).toContain('This needs the internet.');
		expect(await read('log')).not.toContain('apt-get install');
	});

	test('takes a set that needs nothing new without the internet', async () => {
		// Installed by an earlier set, which asked for more than this one does.
		await system({ installed: ['bluez', 'smartify-os-run'], known: ['bluez'] });
		await writeSet({ apt: ['bluez\t*\tSmartifyOS'] });
		const result = Bun.spawnSync(['bash', script, 'packages', set], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, FAKE_OFFLINE: '1' },
		});
		expect({ code: result.exitCode, stderr: result.stderr.toString() }).toMatchObject({ code: 0 });
		const log = await read('log');
		expect(log).not.toContain('apt-get update');
		expect(log).toContain('apt-get install -y -q');
		expect(await depends()).toBe('bluez');
	});

	test('refuses an architecture SmartifyOS does not run on', async () => {
		await writeSet({ apt: ['bluez\t*\tSmartifyOS'] });
		const result = Bun.spawnSync(['bash', script, 'packages', set], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, FAKE_ARCH: 'armhf' },
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain('this machine is armhf');
	});
});

/** The machine `linux.sh system` sets up, standing in for /. */
const sysroot = join(root, 'sysroot');

interface Car {
	user?: string;
	/** Files that are there before, by their path below /. */
	files?: Record<string, string>;
}

async function car({ user = 'pi', files = {} }: Car = {}) {
	await rm(sysroot, { recursive: true, force: true });
	await Bun.write(
		join(sysroot, 'etc/smartify-os/car.conf'),
		`USER=${user}\nDIR=/opt/smartify-os\n`,
	);
	await Bun.write(join(sysroot, 'usr/bin/labwc'), '#!/bin/sh\n');
	await chmod(join(sysroot, 'usr/bin/labwc'), 0o755);
	for (const [path, text] of Object.entries(files)) await Bun.write(join(sysroot, path), text);
}

function setUpSystem(env: Record<string, string> = {}) {
	const result = Bun.spawnSync(['bash', script, 'system'], {
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FAKE: fake,
			NO_COLOR: '1',
			SMARTIFY_OS_SYSROOT: sysroot,
			...env,
		},
	});
	return { code: result.exitCode, stderr: result.stderr.toString() };
}

async function file(path: string): Promise<string> {
	const found = Bun.file(join(sysroot, path));
	return (await found.exists()) ? await found.text() : '';
}

describe('linux.sh system', () => {
	test('starts SmartifyOS with the car, as the user in car.conf, and again whenever it quits', async () => {
		await car();
		const { code, stderr } = setUpSystem();
		expect({ code, stderr }).toMatchObject({ code: 0 });

		const service = await file('etc/systemd/system/smartify-os.service');
		expect(service).toContain('\nUser=pi\n');
		expect(service).toContain('\nRestart=always\n');
		expect(service).toContain('--session /opt/smartify-os/app/smartify-os\n');
		expect(service).toContain('\nPAMName=smartify-os\n');
		expect(await file('etc/pam.d/smartify-os')).toContain('@include common-session');
		expect(await file('etc/smartify-os/labwc/rc.xml')).toContain('ToggleFullscreen');

		const log = await read('log');
		expect(log).toContain(`systemctl --root=${sysroot} enable smartify-os.service`);
		expect(log).toContain(`systemctl --root=${sysroot} set-default graphical.target`);
	});

	test('lets the user use sudo and open USB sticks without a password', async () => {
		await car();
		expect(setUpSystem().code).toBe(0);
		expect(await file('etc/sudoers.d/smartify-os')).toContain('\npi ALL=(ALL:ALL) NOPASSWD: ALL\n');
		const mode = Bun.spawnSync(['ls', '-l', join(sysroot, 'etc/sudoers.d/smartify-os')]);
		expect(mode.stdout.toString()).toStartWith('-r--r-----');
		const rule = await file('etc/polkit-1/rules.d/50-smartify-os.rules');
		expect(rule).toContain('if (subject.user !== "pi")');
		expect(rule).toContain('org.freedesktop.udisks2.filesystem-mount');
	});

	test('leaves the sudo rule out when visudo finds it broken, since that would break sudo', async () => {
		await car();
		const { code, stderr } = setUpSystem({ FAKE_VISUDO: '1' });
		expect(code).toBe(1);
		expect(stderr).toContain('The sudo rule for pi came out broken');
		expect(await file('etc/sudoers.d/smartify-os')).toBe('');
	});

	test('hides the cursor, for labwc and for GTK', async () => {
		await car();
		expect(setUpSystem().code).toBe(0);
		const theme = join(sysroot, 'usr/share/icons/smartify-os-hidden/cursors');
		const cursor = new Uint8Array(await Bun.file(join(theme, 'default')).arrayBuffer());
		// The header, one table entry, one image header and one pixel.
		expect(cursor.length).toBe(16 + 12 + 36 + 4);
		expect(new TextDecoder().decode(cursor.slice(0, 4))).toBe('Xcur');
		expect(cursor.slice(-4)).toEqual(new Uint8Array([0, 0, 0, 0]));
		expect(
			Bun.spawnSync(['readlink', join(theme, 'pointer')])
				.stdout.toString()
				.trim(),
		).toBe('default');
		expect(await file('etc/smartify-os/labwc/environment')).toContain(
			'XCURSOR_THEME=smartify-os-hidden',
		);
		expect(await file('usr/share/glib-2.0/schemas/90_smartify-os.gschema.override')).toContain(
			"cursor-theme='smartify-os-hidden'",
		);
		expect(await read('log')).toContain('glib-compile-schemas');
	});

	test('keeps the keyboard layout chosen when Linux was installed', async () => {
		await car({
			files: { 'etc/default/keyboard': 'XKBMODEL="pc105"\nXKBLAYOUT="de"\nXKBVARIANT=""\n' },
		});
		expect(setUpSystem().code).toBe(0);
		const environment = await file('etc/smartify-os/labwc/environment');
		expect(environment).toContain('XKB_DEFAULT_LAYOUT=de\n');
		expect(environment).toContain('XKB_DEFAULT_MODEL=pc105\n');
		expect(environment).not.toContain('XKB_DEFAULT_VARIANT');
	});

	test('turns off the login screen of a desktop, which would take the screen', async () => {
		await car({ files: { 'lib/systemd/system/lightdm.service': '[Unit]\n' } });
		await mkdir(join(sysroot, 'etc/systemd/system'), { recursive: true });
		Bun.spawnSync([
			'ln',
			'-s',
			'/lib/systemd/system/lightdm.service',
			join(sysroot, 'etc/systemd/system/display-manager.service'),
		]);
		const { code, stderr } = setUpSystem();
		expect({ code, stderr }).toMatchObject({ code: 0 });
		expect(stderr).toContain("The desktop's login screen (lightdm) no longer starts");
		expect(await read('log')).toContain('disable lightdm.service');
	});

	test('quiets GRUB with a file of its own, and updates it', async () => {
		await car({ files: { 'etc/default/grub': 'GRUB_CMDLINE_LINUX_DEFAULT="quiet"\n' } });
		expect(setUpSystem().code).toBe(0);
		const grub = await file('etc/default/grub.d/smartify-os.cfg');
		expect(grub).toContain('GRUB_TIMEOUT=0\n');
		expect(grub).toContain('GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT quiet');
		expect(await file('etc/default/grub')).toBe('GRUB_CMDLINE_LINUX_DEFAULT="quiet"\n');
		expect(await read('log')).toContain('update-grub');
	});

	test("quiets a Raspberry Pi's start, the same however often it runs", async () => {
		const cmdline = 'console=serial0,115200 console=tty1 root=PARTUUID=1234-02 rootwait quiet\n';
		const config = 'dtparam=audio=on\n\n[all]\n';
		await car({
			files: { 'boot/firmware/cmdline.txt': cmdline, 'boot/firmware/config.txt': config },
		});
		expect(setUpSystem().code).toBe(0);
		expect(setUpSystem().code).toBe(0);
		expect(await file('boot/firmware/cmdline.txt')).toBe(
			'console=serial0,115200 console=tty1 root=PARTUUID=1234-02 rootwait quiet loglevel=3 vt.global_cursor_default=0 logo.nologo\n',
		);
		const written = await file('boot/firmware/config.txt');
		expect(written).toStartWith(config);
		expect(written.match(/disable_splash=1/g)).toHaveLength(1);
		expect(await read('log')).not.toContain('update-grub');
	});

	test('refuses a user name that would break the files it goes into', async () => {
		await car({ user: 'pi"; rm -rf /' });
		const { code, stderr } = setUpSystem();
		expect(code).toBe(1);
		expect(stderr).toContain('names no user SmartifyOS can run as');
		expect(await file('etc/sudoers.d/smartify-os')).toBe('');
	});

	test('refuses a machine install.sh has not set up', async () => {
		await car();
		await rm(join(sysroot, 'etc/smartify-os/car.conf'));
		const { code, stderr } = setUpSystem();
		expect(code).toBe(1);
		expect(stderr).toContain('This is not a car yet');
	});
});
