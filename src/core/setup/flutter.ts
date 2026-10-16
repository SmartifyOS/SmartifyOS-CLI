import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { flutterDir, ownFlutterPath, toolsDir } from '../device/tools.ts';
import { desktopPlatform, type FlutterVersion, flutterVersion } from '../flutter.ts';
import { findFlutter, runOrThrow } from '../process.ts';

/**
 * Installing Flutter for an owner who does not have it, so nobody has to follow Flutter's own
 * install guide before they can start their car.
 *
 * It is the newest stable release, cloned at its tag into `~/.smartify-os/tools/flutter`,
 * the same way `linux.sh flutter` installs it on a car (a shallow clone of a branch has no
 * tag, and a Flutter that cannot tell its own version breaks every SDK constraint). A Flutter
 * the owner has already is never touched, and always wins, see `findFlutter`.
 */

const flutterRepo = 'https://github.com/flutter/flutter.git';

/** Where Flutter publishes which release is the newest on each channel. */
function releasesUrl(): string {
	return `https://storage.googleapis.com/flutter_infra_release/releases/releases_${desktopPlatform()}.json`;
}

/**
 * The version of the newest stable release, out of Flutter's releases file:
 * `current_release.stable` is a commit, and the release with that commit names its version.
 */
export function newestStable(releases: unknown): string | undefined {
	if (typeof releases !== 'object' || releases === null) return undefined;
	const { current_release: current, releases: list } = releases as {
		current_release?: { stable?: unknown };
		releases?: unknown;
	};
	const hash = current?.stable;
	if (typeof hash !== 'string' || !Array.isArray(list)) return undefined;
	const release = list.find(
		(entry) =>
			entry?.hash === hash && entry?.channel === 'stable' && typeof entry?.version === 'string',
	) as { version: string } | undefined;
	return release?.version;
}

/** What to do about a computer without git, which Flutter cannot run without. */
export function gitInstallHint(platform: NodeJS.Platform = process.platform): string {
	if (platform === 'darwin') {
		return "Run xcode-select --install, which installs git with Apple's command line tools, then try again.";
	}
	if (platform === 'win32') {
		return 'Install git from https://git-scm.com/downloads/win, open a new terminal and try again.';
	}
	return 'Install git with your package manager, for example sudo apt install git, then try again.';
}

export type FlutterSetUpStep = 'find' | 'download' | 'prepare';

/** What {@link setUpFlutter} found or did. */
export interface FlutterSetUp {
	version: FlutterVersion;
	path: string;
	/** Whether it was installed just now. */
	installed: boolean;
}

/**
 * Installs Flutter, unless this computer has a working one already.
 *
 * @throws {CliError} when there is a Flutter on PATH that does not work (it is the owner's to
 * fix, a second one would only hide it), when git is missing, or when a download fails.
 */
export async function setUpFlutter(
	onStep?: (step: FlutterSetUpStep, version?: string) => void,
): Promise<FlutterSetUp> {
	const found = findFlutter();
	if (found && !found.own) {
		try {
			return { version: await flutterVersion(), path: found.path, installed: false };
		} catch (error) {
			throw notWorking(found.path, error);
		}
	}

	// The one SmartifyOS installed is put right by installing it again when it does not run,
	// and prepared again below when it does, which is quick once nothing is missing.
	const current = found ? await flutterVersion().catch(() => undefined) : undefined;
	const installed = current === undefined;
	const version = current?.version ?? (await downloadFlutter(onStep));

	// The first run fetches Flutter's own Dart, and precache the engine this computer runs a
	// car's app with. Both would otherwise happen in the middle of the first `run`.
	onStep?.('prepare', version);
	await runOrThrow('flutter', ['--disable-analytics'], {
		message: `Flutter ${version} was downloaded, but could not set itself up.`,
		hint: 'Check your internet connection, and run smartify-os setup again.',
	});
	await runOrThrow('flutter', ['precache', `--${desktopPlatform()}`], {
		message: `Flutter ${version} could not download what it runs apps on this computer with.`,
		hint: 'Check your internet connection, and run smartify-os setup again.',
	});

	return { version: await flutterVersion(), path: ownFlutterPath(), installed };
}

/** Internal: clones the newest stable Flutter into place, and gives back its version. */
async function downloadFlutter(
	onStep?: (step: FlutterSetUpStep, version?: string) => void,
): Promise<string> {
	if (!Bun.which('git')) {
		throw new CliError('Flutter needs git, and this computer does not have it yet.', {
			hint: gitInstallHint(),
		});
	}

	onStep?.('find');
	const version = await newestStableVersion();

	onStep?.('download', version);
	await mkdir(toolsDir(), { recursive: true });
	const staging = await mkdtemp(join(toolsDir(), '.flutter-'));
	try {
		const clone = join(staging, 'flutter');
		await runOrThrow(
			'git',
			[
				'-c',
				'advice.detachedHead=false',
				'clone',
				'--quiet',
				'--depth',
				'1',
				'--branch',
				version,
				flutterRepo,
				clone,
			],
			{
				message: `Could not download Flutter ${version}.`,
				hint: 'Check your internet connection.',
			},
		);
		// A clone of a tag is on no branch, which Flutter calls the channel `[user-branch]`. On
		// a `stable` that tracks the real one, it says stable, and `flutter upgrade` works.
		for (const args of [
			['checkout', '--quiet', '-b', 'stable'],
			['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
			['update-ref', 'refs/remotes/origin/stable', 'HEAD'],
			['config', 'branch.stable.remote', 'origin'],
			['config', 'branch.stable.merge', 'refs/heads/stable'],
		]) {
			await runOrThrow('git', ['-C', clone, ...args], {
				message: `Could not set Flutter ${version} up as the stable channel.`,
			});
		}
		await rm(flutterDir(), { recursive: true, force: true });
		await rename(clone, flutterDir());
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
	return version;
}

/** Internal: the newest stable Flutter, asked of Flutter's own release list. */
async function newestStableVersion(): Promise<string> {
	const url = releasesUrl();
	const response = await fetch(url).catch(() => undefined);
	const version = response?.ok ? newestStable(await response.json().catch(() => null)) : undefined;
	if (!version) {
		throw new CliError('Could not find out which Flutter is the newest.', {
			hint: `Check your internet connection. ${url}${response && !response.ok ? ` answered ${response.status}.` : ''}`,
		});
	}
	return version;
}

/** Internal: the error for a Flutter on PATH that does not answer. */
function notWorking(path: string, error: unknown): CliError {
	return new CliError(`There is a Flutter at ${path}, but it does not work.`, {
		hint: [
			'Run flutter doctor to see what is wrong with it, or take it off your PATH and run smartify-os setup to get one that works.',
			error instanceof CliError ? error.hint : undefined,
		]
			.filter(Boolean)
			.join('\n'),
		cause: error,
	});
}
