import type { AptNeed, GroupNeed, Requester, UdevNeed } from './collect.ts';

/**
 * A package set: everything one machine gets installed for one purpose, written as plain
 * files that `linux.sh packages` reads on that machine and turns into one generated `.deb`.
 *
 * `smartify-os-run` is what a car needs to run SmartifyOS, `smartify-os-build` what a
 * machine needs to build it. Keeping them apart lets a car that stops building itself drop
 * everything building needed.
 *
 * The files are tab separated lines, simple enough for a shell script to read without
 * anything that might not be installed, and for SmartifyOS on the car to read later:
 *
 *   apt.list     package, architectures (`x64,arm64` or `*`), who asked
 *   groups.list  group, who asked
 *   udev.list    installed file name, who asked
 *   udev/        the rule files themselves
 *   set.conf     NAME, DESCRIPTION, FLUTTER_TOOLCHAIN
 */

export type SetName = 'smartify-os-run' | 'smartify-os-build';

export interface PackageSet {
	name: SetName;
	/**
	 * What it is for, reading on after "Everything ... needs": `SmartifyOS`, or
	 * `building SmartifyOS`. It is the `.deb`'s description and what linux.sh says.
	 */
	description: string;
	apt: AptNeed[];
	udev: UdevNeed[];
	groups: GroupNeed[];
	/**
	 * Whether this set builds Flutter apps, in which case the `libstdc++-N-dev` matching the
	 * GCC clang picks is added on the machine, since only there can N be worked out.
	 */
	flutterToolchain: boolean;
}

/** Who asked for Flutter's own Linux toolchain. */
export const flutterRequester: Requester = { name: 'flutter', title: 'Flutter' };

/**
 * What building any Flutter Linux app needs, from Flutter's Linux setup guide, plus
 * binutils for reading which libraries a build links against. The `libstdc++-N-dev` is
 * added on the machine, see {@link PackageSet.flutterToolchain}.
 */
export const flutterToolchain: readonly string[] = [
	'binutils',
	'clang',
	'cmake',
	'curl',
	'git',
	'libgtk-3-dev',
	'liblzma-dev',
	'ninja-build',
	'pkg-config',
	'unzip',
	'xz-utils',
	'zip',
];

/** Flutter's toolchain as needs, to go in front of the build list. */
export function flutterToolchainNeeds(): AptNeed[] {
	return flutterToolchain.map((name) => ({
		package: name,
		arch: null,
		requesters: [flutterRequester],
	}));
}

/**
 * Adds needs to a list, merging requesters of a package asked for twice. Used to put
 * Flutter's toolchain and the libraries a build links against next to what packages listed.
 */
export function addNeeds(list: AptNeed[], extra: AptNeed[]): AptNeed[] {
	const merged = new Map(
		list.map((need) => [need.package, { ...need, requesters: [...need.requesters] }]),
	);
	for (const need of extra) {
		const existing = merged.get(need.package);
		if (!existing) {
			merged.set(need.package, { ...need, requesters: [...need.requesters] });
			continue;
		}
		if (existing.arch !== null && need.arch !== null) {
			existing.arch = [...new Set([...existing.arch, ...need.arch])].sort();
		} else {
			existing.arch = null;
		}
		for (const requester of need.requesters) {
			if (!existing.requesters.some((r) => r.name === requester.name)) {
				existing.requesters.push(requester);
			}
		}
	}
	return [...merged.values()].sort((a, b) => a.package.localeCompare(b.package));
}

/** Internal: a value that cannot break a tab separated line. */
function field(text: string): string {
	return text.replace(/[\t\r\n]+/g, ' ').trim();
}

function requesters(list: Requester[]): string {
	return field(list.map((r) => r.title).join(', '));
}

const header = (columns: string) => [
	`# Written by smartify-os, read by linux.sh. Tab separated: ${columns}.`,
];

/** The files of a set, by their path inside the set's folder. */
export function renderSet(set: PackageSet): Map<string, string> {
	const files = new Map<string, string>();
	const lines = (list: string[]) => `${list.join('\n')}\n`;

	files.set(
		'set.conf',
		lines([
			`NAME=${set.name}`,
			`DESCRIPTION=${field(set.description)}`,
			`FLUTTER_TOOLCHAIN=${set.flutterToolchain ? 1 : 0}`,
		]),
	);
	files.set(
		'apt.list',
		lines([
			...header('package, architectures, who asked'),
			...set.apt.map((need) =>
				[need.package, need.arch ? need.arch.join(',') : '*', requesters(need.requesters)].join(
					'\t',
				),
			),
		]),
	);
	files.set(
		'groups.list',
		lines([
			...header('group, who asked'),
			...set.groups.map((need) => [need.group, requesters(need.requesters)].join('\t')),
		]),
	);
	files.set(
		'udev.list',
		lines([
			...header('installed file name, who asked'),
			...set.udev.map((rule) => [rule.name, field(rule.requester.title)].join('\t')),
		]),
	);
	for (const rule of set.udev) files.set(`udev/${rule.name}`, rule.text);
	return files;
}

/**
 * Reads what `linux.sh libraries` printed: `apt.list` lines for the libraries a build
 * links against. Lines that are not in that shape are skipped.
 */
export function parseAptList(text: string): AptNeed[] {
	const needs: AptNeed[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || line.startsWith('#')) continue;
		const [name, arch, who] = line.split('\t');
		if (!name || !/^[a-z0-9][a-z0-9+.-]+$/.test(name)) continue;
		needs.push({
			package: name,
			arch: !arch || arch === '*' ? null : (arch.split(',') as AptNeed['arch']),
			requesters: (who ?? '')
				.split(', ')
				.filter(Boolean)
				.map((title) => ({ name: title, title })),
		});
	}
	return needs;
}
