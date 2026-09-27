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
update | autoremove) exit 0 ;;
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

	test('refuses an architecture SmartifyOS does not run on', async () => {
		await writeSet({ apt: ['bluez\t*\tSmartifyOS'] });
		const result = Bun.spawnSync(['bash', script, 'packages', set], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, FAKE_ARCH: 'armhf' },
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain('this machine is armhf');
	});
});
