import { type LinuxArch, linuxArchs } from './distro.ts';

/**
 * Reading what one package says it needs installed on Linux: the `smartify_os:` key of its
 * pubspec.yaml, in the format EXTENSIONS.md ("Linux packages") tells authors to write.
 *
 * ```yaml
 * smartify_os:
 *   linux:
 *     build:
 *       apt: [libusb-1.0-0-dev]
 *     run:
 *       apt:
 *         - iw
 *         - package: intel-media-va-driver
 *           arch: [x64]
 *       udev: [system/udev/70-android-auto.rules]
 *       groups: [plugdev]
 * ```
 *
 * Nothing in here throws. A broken entry is left out and reported as a problem, so one
 * mistake never stops the rest from being installed, and a key this CLI does not know is
 * reported too, since it most likely comes from a newer SmartifyOS.
 */

/** One package to install with apt. */
export interface AptEntry {
	package: string;
	/** Only on these architectures. Undefined for every one. */
	arch: LinuxArch[] | undefined;
}

/** Everything one package lists. */
export interface PackageLists {
	build: AptEntry[];
	run: AptEntry[];
	/** Paths of udev rule files, relative to the package's folder, as written. */
	udev: string[];
	groups: string[];
}

/** Something in a package's lists that cannot be used. */
export interface ListProblem {
	/**
	 * `invalid`: a mistake, the entry is skipped. `unknown`: something this CLI does not know
	 * how to set up yet, which a newer one might.
	 */
	kind: 'invalid' | 'unknown';
	/** Where in pubspec.yaml, `smartify_os.linux.run.apt[2]`. */
	path: string;
	message: string;
}

/**
 * Groups the car's user may be added to. An allowlist rather than a blocklist, because
 * `sudo`, `disk`, `docker` or `shadow` are root in disguise, and a blocklist only has to
 * miss one of them.
 */
export const allowedGroups: readonly string[] = [
	'plugdev',
	'dialout',
	'input',
	'video',
	'render',
	'audio',
	'bluetooth',
	'netdev',
	'gpio',
	'i2c',
	'spi',
];

/** A Debian package name. */
const packageName = /^[a-z0-9][a-z0-9+.-]+$/;

/** What a udev rule file has to be called: the number deciding its order, then a name. */
const udevFileName = /^(\d\d)-([A-Za-z0-9_.-]+)\.rules$/;

/** The empty lists, for a package that lists nothing. */
export function emptyLists(): PackageLists {
	return { build: [], run: [], udev: [], groups: [] };
}

/**
 * Reads the value of `smartify_os:` in a pubspec. Undefined (no such key) means the package
 * needs nothing.
 */
export function parseLists(value: unknown): { lists: PackageLists; problems: ListProblem[] } {
	const lists = emptyLists();
	const problems: ListProblem[] = [];
	const problem = (kind: ListProblem['kind'], path: string, message: string) =>
		problems.push({ kind, path, message });

	if (value === undefined || value === null) return { lists, problems };

	const root = asMap(value, 'smartify_os', problem);
	if (!root) return { lists, problems };
	unknownKeys(root, ['linux'], 'smartify_os', problem);

	const linux = asMap(root.linux, 'smartify_os.linux', problem);
	if (!linux) return { lists, problems };
	unknownKeys(linux, ['build', 'run'], 'smartify_os.linux', problem);

	const build = asMap(linux.build, 'smartify_os.linux.build', problem);
	if (build) {
		unknownKeys(build, ['apt'], 'smartify_os.linux.build', problem);
		lists.build = readApt(build.apt, 'smartify_os.linux.build.apt', problem);
	}

	const run = asMap(linux.run, 'smartify_os.linux.run', problem);
	if (run) {
		unknownKeys(run, ['apt', 'udev', 'groups'], 'smartify_os.linux.run', problem);
		lists.run = readApt(run.apt, 'smartify_os.linux.run.apt', problem);
		lists.udev = readStrings(run.udev, 'smartify_os.linux.run.udev', problem)
			.filter(({ value, path }) => {
				const why = checkUdevPath(value);
				if (why) problem('invalid', path, why);
				return !why;
			})
			.map(({ value }) => value);
		lists.groups = readStrings(run.groups, 'smartify_os.linux.run.groups', problem)
			.filter(({ value, path }) => {
				if (allowedGroups.includes(value)) return true;
				problem(
					'invalid',
					path,
					`The group ${value} is not one SmartifyOS adds anybody to. These are: ${allowedGroups.join(', ')}.`,
				);
				return false;
			})
			.map(({ value }) => value);
	}

	return { lists, problems };
}

type Report = (kind: ListProblem['kind'], path: string, message: string) => void;

/** Internal: a map, or undefined (reported unless it is simply missing). */
function asMap(value: unknown, path: string, problem: Report): Record<string, unknown> | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	problem('invalid', path, `${path} has to hold keys, like the example in EXTENSIONS.md.`);
	return undefined;
}

/** Internal: reports every key that is not one of `known`. */
function unknownKeys(map: Record<string, unknown>, known: string[], path: string, problem: Report) {
	for (const key of Object.keys(map)) {
		if (!known.includes(key)) {
			problem('unknown', `${path}.${key}`, `This smartify-os does not know ${path}.${key}.`);
		}
	}
}

/** Internal: the strings of a list, each with where it is. Anything else is reported. */
function readStrings(
	value: unknown,
	path: string,
	problem: Report,
): { value: string; path: string }[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		problem('invalid', path, `${path} has to be a list.`);
		return [];
	}
	const found: { value: string; path: string }[] = [];
	value.forEach((item, index) => {
		const at = `${path}[${index}]`;
		if (typeof item === 'string' && item.trim()) found.push({ value: item.trim(), path: at });
		else problem('invalid', at, `${at} has to be text.`);
	});
	return found;
}

/** Internal: an `apt:` list, whose entries are a name or a `package` with an `arch`. */
function readApt(value: unknown, path: string, problem: Report): AptEntry[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		problem('invalid', path, `${path} has to be a list of package names.`);
		return [];
	}

	const entries: AptEntry[] = [];
	value.forEach((item, index) => {
		const at = `${path}[${index}]`;
		const entry = readAptEntry(item, at, problem);
		if (entry) entries.push(entry);
	});
	return entries;
}

function readAptEntry(item: unknown, path: string, problem: Report): AptEntry | undefined {
	let name: unknown = item;
	let arch: LinuxArch[] | undefined;

	if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
		const map = item as Record<string, unknown>;
		unknownKeys(map, ['package', 'arch'], path, problem);
		name = map.package;
		if (map.arch !== undefined && map.arch !== null) {
			// A single architecture written without the brackets is fine too.
			const given = Array.isArray(map.arch) ? map.arch : [map.arch];
			const wrong = given.filter((a) => !linuxArchs.includes(a as LinuxArch));
			if (wrong.length > 0 || given.length === 0) {
				problem(
					'invalid',
					`${path}.arch`,
					`arch can only be ${linuxArchs.join(' and ')}, not ${wrong.map(String).join(', ') || 'empty'}.`,
				);
				return undefined;
			}
			arch = [...new Set(given as LinuxArch[])];
		}
	}

	if (typeof name !== 'string' || !name.trim()) {
		problem('invalid', path, `${path} has to be a package name, or a package with an arch.`);
		return undefined;
	}
	const trimmed = name.trim();
	if (!packageName.test(trimmed)) {
		problem(
			'invalid',
			path,
			`${trimmed} is not a package name. Package names are lowercase letters, numbers and + . -, without a version.`,
		);
		return undefined;
	}
	return { package: trimmed, arch };
}

/** Why a udev path cannot be used, or undefined when it can. */
export function checkUdevPath(path: string): string | undefined {
	if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
		return `${path} has to be a path inside the package, like system/udev/70-my_feature.rules.`;
	}
	if (path.split('/').some((part) => part === '..')) {
		return `${path} points outside the package, which is not allowed.`;
	}
	const name = path.split('/').pop() ?? '';
	if (!udevFileName.test(name)) {
		return `${name} has to be named like 70-my_feature.rules: two digits, a dash, a name, then .rules.`;
	}
	return undefined;
}

/**
 * Why a udev rule file cannot be installed, or undefined when it can.
 *
 * `RUN`, `PROGRAM` and `IMPORT{program}` start programs as root, which an extension must
 * never get through a rules file. Rules may only set permissions.
 */
export function checkUdevRule(text: string): string | undefined {
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const found = /(?:^|[\s,])(RUN|PROGRAM|IMPORT\{program\})\s*(?:\{[^}]*\})?\s*[+:!=]?=/.exec(
			line,
		);
		if (found) {
			return `Line ${index + 1} uses ${found[1]}, which would run a program as root. Rules may only set permissions (MODE, OWNER, GROUP, TAG+="uaccess", SYMLINK, ENV).`;
		}
	}
	return undefined;
}

/**
 * The name a rule file is installed under: the package name after the author's number, so
 * two extensions can never overwrite each other's rules, and the number still decides the
 * order. `70-android-auto.rules` of `smartify_os_android_auto` becomes
 * `70-smartify_os_android_auto-android-auto.rules`.
 */
export function installedRuleName(packageName: string, path: string): string {
	const name = path.split('/').pop() ?? path;
	const match = udevFileName.exec(name);
	if (!match) return `${packageName}-${name}`;
	return `${match[1]}-${packageName}-${match[2]}.rules`;
}
