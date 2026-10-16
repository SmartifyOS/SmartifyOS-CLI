import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { version } from '../../utils/version.ts';
import { currentBinaryPath, isCompiledBinary } from '../runtime.ts';
import {
	assetUrl,
	downloadAsset,
	fetchText,
	parseChecksums,
	repo,
	resolveLatestTag,
	sha256OfFile,
	tagFromVersion,
	versionFromTag,
} from './release.ts';
import { archiveName, binaryNameFor, currentTarget, type ReleaseTarget } from './target.ts';

/**
 * Replacing the running binary with a newer one.
 *
 * The order of the steps is the whole design. Everything that can fail is done before
 * anything is changed, and the last step is a single rename, so that at no point is the
 * user left without a working `smartify-os`.
 */

/** What an update is going to do, worked out before any of it is done. */
export interface UpdatePlan {
	currentVersion: string;
	targetVersion: string;
	tag: string;
	target: ReleaseTarget;
	archive: string;
	url: string;
	baseUrl: string | undefined;
}

export type InstallStep = 'download' | 'verify' | 'unpack' | 'check' | 'swap';

export interface InstallEvents {
	onStep?(step: InstallStep): void;
	onProgress?(received: number, total: number): void;
}

/** Whether there is a binary here to replace at all. False when running from source. */
export function isUpdatable(): boolean {
	return isCompiledBinary();
}

/** Works out what would be installed, without downloading anything. */
export async function planUpdate(
	options: { to?: string | undefined; baseUrl?: string | undefined } = {},
): Promise<UpdatePlan> {
	const tag = options.to ? tagFromVersion(options.to) : await resolveLatestTag();
	const target = currentTarget();
	const archive = archiveName(target);

	return {
		currentVersion: version,
		targetVersion: versionFromTag(tag),
		tag,
		target,
		archive,
		url: assetUrl(tag, archive, options.baseUrl),
		baseUrl: options.baseUrl,
	};
}

/**
 * Downloads, checks and installs the version the plan names.
 *
 * @throws {CliError} at any step, always with the message saying whether anything changed.
 */
export async function applyUpdate(plan: UpdatePlan, events: InstallEvents = {}): Promise<void> {
	const current = currentBinaryPath();
	const installDir = dirname(current);

	// Staged next to the binary, never in the system temp folder. On Linux /tmp is very
	// often a different filesystem, and a rename across filesystems is not merely non
	// atomic, it is not possible. Making the folder here is also the cheapest way to find
	// out straight away that this folder is not ours to write to.
	const staging = await stageDir(installDir);

	try {
		const archivePath = join(staging, plan.archive);

		events.onStep?.('download');
		await downloadAsset(plan.url, archivePath, events.onProgress);

		events.onStep?.('verify');
		await verifyChecksum(plan, archivePath);

		events.onStep?.('unpack');
		await unpack(archivePath, staging);

		const staged = join(staging, binaryNameFor(plan.target));
		if (!existsSync(staged)) {
			throw new CliError(`The download did not contain ${binaryNameFor(plan.target)}.`, {
				hint: 'Nothing was changed. Please try again.',
			});
		}
		if (process.platform !== 'win32') await chmod(staged, 0o755);

		events.onStep?.('check');
		await proveItRuns(staged, plan.targetVersion);

		events.onStep?.('swap');
		await swapIn(staged, current);
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Deletes the binary a previous update had to park, if the system has let go of it by now.
 *
 * Only Windows ever leaves one behind. Nothing is recorded anywhere, because the name is
 * always the running binary with `.old` on the end, worked out exactly the way `swapIn`
 * worked it out. Never throws, never says anything.
 */
export async function sweepReplacedBinary(): Promise<void> {
	if (process.platform !== 'win32') return;
	// From the source tree there is no binary of ours here, only Bun itself.
	if (!isUpdatable()) return;
	await rm(`${currentBinaryPath()}.old`, { force: true }).catch(() => {});
}

/** Internal: makes the staging folder, and turns "you cannot write here" into advice. */
async function stageDir(installDir: string): Promise<string> {
	try {
		return await mkdtemp(join(installDir, '.smartify-os-update-'));
	} catch (error) {
		throw notWritable(error, installDir);
	}
}

/**
 * Internal: one message for wherever the install folder turns out to belong to someone else.
 *
 * This is what a package manager install looks like from in here. Replacing a file in
 * /usr/local/bin behind whatever put it there is worse than not updating at all, so the
 * thing to do is name who should be doing it instead.
 */
function notWritable(error: unknown, installDir: string): unknown {
	const code = (error as NodeJS.ErrnoException)?.code;
	if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') return error;

	return new CliError(`SmartifyOS cannot write to ${installDir}, so nothing was changed.`, {
		hint: 'It was not put there by the SmartifyOS installer, so whatever did put it there is what should update it. Installing again from https://smartify-os.com/ also works, and needs no admin rights.',
		cause: error,
	});
}

/** Internal: checks the download against the checksum published with the same release. */
async function verifyChecksum(plan: UpdatePlan, archivePath: string): Promise<void> {
	const sums = parseChecksums(await fetchText(assetUrl(plan.tag, 'checksums.txt', plan.baseUrl)));
	const expected = sums.get(plan.archive);

	if (!expected) {
		throw new CliError(`Release ${plan.tag} has no checksum for ${plan.archive}.`, {
			hint: `Nothing was changed. Please report it at https://github.com/${repo}/issues`,
		});
	}

	if ((await sha256OfFile(archivePath)) !== expected) {
		throw new CliError('The download does not match its checksum.', {
			hint: 'Something went wrong on the way. Nothing was changed, please try again.',
		});
	}
}

/**
 * Unpacks a downloaded `.tar.gz` or `.zip`. Also how uv is unpacked, see
 * src/core/device/platformio.ts.
 *
 * `tar` on macOS, on Linux and on Windows 10 1803 and later is all bsdtar, and bsdtar reads
 * a zip as happily as a tar.gz, so one tool covers every platform there is a build for.
 */
export async function unpack(archivePath: string, into: string): Promise<void> {
	const args = archivePath.endsWith('.zip')
		? ['tar', '-xf', archivePath, '-C', into]
		: ['tar', '-xzf', archivePath, '-C', into];

	let failure = '';
	try {
		const proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'pipe' });
		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		if (code === 0) return;
		failure = stderr.trim();
	} catch (error) {
		// Bun.spawn throws rather than returning a code when the program is not there at all.
		failure = error instanceof Error ? error.message : String(error);
	}

	// An older Windows has no tar.exe, but every Windows has PowerShell, and this is the
	// same call install.ps1 makes.
	if (process.platform === 'win32' && (await expandArchive(archivePath, into))) return;

	throw new CliError('Could not unpack the download, so nothing was changed.', {
		hint: failure || 'Make sure `tar` is installed, then try again.',
	});
}

/** Internal: the Windows fallback for unpacking a zip. Returns whether it worked. */
async function expandArchive(archivePath: string, into: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(
			[
				'powershell',
				'-NoProfile',
				'-Command',
				`Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${into}' -Force`,
			],
			{ stdout: 'ignore', stderr: 'ignore' },
		);
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

/**
 * Internal: runs the downloaded binary before a single thing has been replaced.
 *
 * This is what catches the wrong processor, a missing system library and a signature that
 * did not survive the trip, at the one moment when walking away costs the user nothing.
 */
async function proveItRuns(path: string, expected: string): Promise<void> {
	const proc = Bun.spawn([path, '--version'], { stdout: 'pipe', stderr: 'pipe' });
	const stopWaiting = setTimeout(() => proc.kill(), 30_000);

	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(stopWaiting);

	if (code !== 0) {
		// Keep what the loader said. When this fails it is usually a missing system library,
		// and the line naming it is the only useful thing there is to go on.
		const firstLine = stderr.trim().split('\n')[0];
		throw new CliError('The new version does not run on this machine, so nothing was changed.', {
			hint: firstLine || `Please report it at https://github.com/${repo}/issues`,
		});
	}

	const reported = stdout.trim().split(' ')[0] ?? '';
	if (reported !== expected) {
		throw new CliError(`The download says it is ${reported}, but ${expected} was asked for.`, {
			hint: 'Nothing was changed. Please try again.',
		});
	}
}

/**
 * Internal: puts the new binary where the old one is.
 *
 * On macOS and Linux one rename does it, atomically, and it is allowed to happen while the
 * old file is still running because this process holds on to the inode it started from.
 * Copying over it instead would be wrong twice over: it is not atomic, and overwriting a
 * running signed binary in place gets the process killed on macOS.
 *
 * Windows will not let a running .exe be deleted, but it will let it be renamed, so the old
 * one is moved aside first and moved back if the second step does not work.
 */
async function swapIn(staged: string, current: string): Promise<void> {
	if (process.platform !== 'win32') {
		try {
			await rename(staged, current);
		} catch (error) {
			throw notWritable(error, dirname(current));
		}
		return;
	}

	const parked = `${current}.old`;
	await rm(parked, { force: true }).catch(() => {});

	try {
		await rename(current, parked);
	} catch (error) {
		throw notWritable(error, dirname(current));
	}

	try {
		await rename(staged, current);
	} catch (error) {
		// Put the old one back. A half done swap must never leave someone with no CLI.
		await rename(parked, current).catch(() => {});
		throw notWritable(error, dirname(current));
	}

	// Windows keeps the old file locked until this process ends, so this usually does
	// nothing. sweepReplacedBinary picks it up the next time the CLI starts.
	await rm(parked, { force: true }).catch(() => {});
}
