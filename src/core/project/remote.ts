import { CliError } from '../../utils/errors.ts';
import { compareVersions, meetsLowerBound } from '../../utils/semver.ts';
import {
	defaultBranch,
	displayUrl,
	type GitSource,
	listReleases,
	type Release,
	readRemoteFile,
} from '../git.ts';
import { dependsOnCore, parsePubspec } from '../pubspec/read.ts';
import { corePackage } from '../smartify-os.ts';

/**
 * What an extension that is not installed yet, or not at this version, says about itself,
 * read from its repository.
 */

/** One extension at one tag or branch. */
export interface RemoteExtension {
	source: GitSource;
	/** Whether `source.ref` is a release tag or a branch. */
	onBranch: boolean;
	packageName: string;
	version: string | undefined;
	/** What it says about SmartifyOS: `">=0.2.0"`, `any`, or nothing. */
	coreConstraint: unknown;
}

/**
 * Reads an extension's pubspec.yaml at a tag or branch.
 *
 * @throws {CliError} when there is no pubspec, or it does not use SmartifyOS at all.
 */
export async function readRemoteExtension(
	url: string,
	ref: string,
	onBranch: boolean,
): Promise<RemoteExtension> {
	const text = await readRemoteFile(url, ref, 'pubspec.yaml');
	if (!text) {
		throw new CliError(`${displayUrl(url)} is not a Flutter package.`, {
			hint: 'An extension has a pubspec.yaml at the top of its repository. Check the address.',
		});
	}

	const pubspec = parsePubspec(text, `pubspec.yaml of ${displayUrl(url)}`);
	if (typeof pubspec.name !== 'string' || !dependsOnCore(pubspec)) {
		throw new CliError(`${displayUrl(url)} is not a SmartifyOS extension.`, {
			hint: 'An extension depends on smartify_os_core. Check the address.',
		});
	}

	return {
		source: { url, ref },
		onBranch,
		packageName: pubspec.name,
		version: typeof pubspec.version === 'string' ? pubspec.version : undefined,
		coreConstraint: pubspec.dependencies?.[corePackage],
	};
}

/**
 * The newest an extension has: its newest release, or the newest commit on its default
 * branch when it has never made one. Its releases come along, newest first.
 */
export async function newestExtension(
	url: string,
): Promise<{ releases: Release[]; newest: RemoteExtension }> {
	const releases = await listReleases(url);
	const [latest] = releases;
	if (latest) return { releases, newest: await readRemoteExtension(url, latest.tag, false) };

	const { branch } = await defaultBranch(url);
	return { releases, newest: await readRemoteExtension(url, branch, true) };
}

/** What {@link newestFitting} found. */
export interface FittingRelease {
	/** The newest release that works with the car's SmartifyOS. */
	fits: RemoteExtension | undefined;
	/** Newer releases than that, each needing a newer SmartifyOS than the car has. */
	needsNewerCore: RemoteExtension[];
}

/**
 * The newest release of an extension that works with a SmartifyOS version, looking only at
 * releases newer than `after` when it is given.
 *
 * Each release's own pubspec is read, newest first, until one fits, since the lower bound
 * is the only thing that says which SmartifyOS a release needs.
 */
export async function newestFitting(
	url: string,
	releases: Release[],
	coreVersion: string,
	after?: string,
): Promise<FittingRelease> {
	const needsNewerCore: RemoteExtension[] = [];
	const candidates = after
		? releases.filter((release) => compareVersions(release.version, after) > 0)
		: releases;

	for (const release of candidates) {
		const extension = await readRemoteExtension(url, release.tag, false);
		if (meetsLowerBound(extension.coreConstraint, coreVersion)) {
			return { fits: extension, needsNewerCore };
		}
		needsNewerCore.push(extension);
	}
	return { fits: undefined, needsNewerCore };
}
