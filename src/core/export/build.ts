import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import type { AptNeed, CarNeeds } from '../linux/collect.ts';
import type { LinuxArch } from '../linux/distro.ts';
import { scripts } from '../linux/scripts.ts';
import { addNeeds, flutterToolchainNeeds, parseAptList, renderSet } from '../linux/set.ts';
import { lastLines, type ProcessResult, run } from '../process.ts';

/**
 * Building the car's app into a finished Linux build right here, on a computer that runs
 * the official Linux itself, and what that and a build in a container (container.ts) share.
 */

/**
 * The name of the program in a build of the car's app, from `BINARY_NAME` in its
 * linux/CMakeLists.txt, or undefined when it has no Linux part yet.
 */
export async function binaryName(appDir: string): Promise<string | undefined> {
	const file = Bun.file(join(appDir, 'linux', 'CMakeLists.txt'));
	if (!(await file.exists())) return undefined;
	return /set\(\s*BINARY_NAME\s+"([^"]+)"\s*\)/.exec(await file.text())?.[1];
}

/** A folder holding linux.sh and the package set for building, for running as root. */
export interface BuildTools {
	dir: string;
	script: string;
	set: string;
	remove(): Promise<void>;
}

/** Writes linux.sh and what building needs to a temporary folder. */
export async function writeBuildTools(needs: CarNeeds): Promise<BuildTools> {
	const dir = await mkdtemp(join(tmpdir(), 'smartify-os-build-'));
	const script = join(dir, 'linux.sh');
	await Bun.write(script, scripts['linux.sh']);
	const set = join(dir, 'build');
	const files = renderSet({
		name: 'smartify-os-build',
		description: 'building SmartifyOS',
		apt: addNeeds(flutterToolchainNeeds(), needs.build),
		udev: [],
		groups: [],
		flutterToolchain: true,
	});
	for (const [path, text] of files) await Bun.write(join(set, path), text);
	return { dir, script, set, remove: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * `flutter build linux --release` in the car's app.
 *
 * @throws {CliError} with the end of Flutter's output when it does not build.
 */
export async function buildBundle(appDir: string, arch: LinuxArch): Promise<string> {
	const result = await run('flutter', ['build', 'linux', '--release'], { cwd: appDir });
	if (result.code !== 0) {
		throw new CliError('SmartifyOS did not build.', {
			hint: lastLines(`${result.stdout}\n${result.stderr}`, 25),
		});
	}
	return join(appDir, 'build', 'linux', arch, 'release', 'bundle');
}

/**
 * The packages owning the libraries a build links against, found by linux.sh on this
 * computer, which runs the same Linux as the car. `warnings` are the libraries no package
 * installed, which the car cannot get.
 */
export async function bundleLibraries(
	tools: BuildTools,
	bundle: string,
): Promise<{ libraries: AptNeed[]; warnings: string[] }> {
	const result = await run('bash', [tools.script, 'libraries', bundle], {
		env: { NO_COLOR: '1' },
	});
	if (result.code !== 0) {
		throw new CliError('Could not read which libraries the build links against.', {
			hint: lastLines(result.stderr),
		});
	}
	return parseLibraries(result);
}

/** What `linux.sh libraries` printed: the packages on stdout, the warnings on stderr. */
export function parseLibraries(result: Pick<ProcessResult, 'stdout' | 'stderr'>): {
	libraries: AptNeed[];
	warnings: string[];
} {
	const warnings = result.stderr
		.split('\n')
		.filter((line) => /^\s*!/.test(line))
		.map((line) => line.replace(/^\s*!\s*/, '').trim());
	// Which file of the build needs each is kept for a program, a person reads "the build".
	const libraries = parseAptList(result.stdout).map((need) => ({
		...need,
		requesters: need.requesters.map((r) => ({ name: r.name, title: 'the build' })),
	}));
	return { libraries: addNeeds([], libraries), warnings };
}
