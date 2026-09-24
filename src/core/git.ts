import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../utils/errors.ts';
import { compareVersions, parseVersion } from '../utils/semver.ts';
import { version as cliVersion } from '../utils/version.ts';
import { run } from './process.ts';

/**
 * What a git repository has to offer, asked of the repository itself.
 *
 * SmartifyOS and its extensions are not on pub.dev, each release is a `vX.Y.Z` tag in its
 * own repository. So "which versions are there" is `git ls-remote`, and "what does this
 * version say" is one file read at that tag, straight from GitHub where possible.
 */

/** One release, as a tag in a repository. */
export interface Release {
	/** `v0.3.0`. */
	tag: string;
	/** `0.3.0`. */
	version: string;
	commit: string;
}

/** Where a package comes from in git: a repository, a folder in it, and a tag or a branch. */
export interface GitSource {
	url: string;
	/** The folder inside the repository the package is in, when it is not at the top. */
	path?: string | undefined;
	ref: string;
}

const remoteTimeoutMs = 60_000;

/**
 * Makes whatever someone pasted into a repository url git and pub both understand.
 *
 * Takes `https://github.com/owner/repo`, the same with `.git` or a trailing slash, a link to
 * a page inside it (`/tree/main`), `github.com/owner/repo` and plain `owner/repo`. Anything
 * that is clearly a url already, like `git@...` or `file://...`, is passed on as it is.
 */
export function normalizeRepoUrl(input: string): string {
	const trimmed = input.trim().replace(/\/+$/, '');

	const github =
		/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(
			trimmed,
		);
	if (github) return `https://github.com/${github[1]}/${github[2]}.git`;

	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) && !trimmed.startsWith('.')) {
		return `https://github.com/${trimmed.replace(/\.git$/, '')}.git`;
	}

	return trimmed;
}

/** `https://github.com/owner/repo.git` gives `owner/repo`, anything not on GitHub nothing. */
export function githubRepo(url: string): string | undefined {
	const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

/** The short form of a url for a sentence: `owner/repo` on GitHub, the url elsewhere. */
export function displayUrl(url: string): string {
	return githubRepo(url) ?? url;
}

/**
 * Reads `git ls-remote --tags` output into releases, newest first.
 *
 * Only tags that are a version count, so a tag like `before-rewrite` is never offered as a
 * release. Prereleases are kept, sorted below the release they lead up to.
 */
export function parseTags(output: string): Release[] {
	const releases: Release[] = [];

	for (const line of output.split('\n')) {
		const match = /^([0-9a-f]{40})\s+refs\/tags\/(v\d[^\s^]*)$/.exec(line.trim());
		if (!match?.[1] || !match[2] || !parseVersion(match[2])) continue;
		releases.push({ tag: match[2], version: match[2].slice(1), commit: match[1] });
	}

	return releases.sort((a, b) => compareVersions(b.version, a.version));
}

/** Internal: turns a failed `git ls-remote` into something a car owner can act on. */
function unreachable(url: string, stderr: string): CliError {
	const notFound = /not found|does not exist|could not read Username|terminal prompts disabled/i;
	return new CliError(
		notFound.test(stderr)
			? `There is no repository at ${url}, or it is private.`
			: `Could not reach ${url}.`,
		{
			hint: notFound.test(stderr)
				? 'Check the address. It is the one in your browser on the repository page.'
				: 'Check your internet connection and try again.',
		},
	);
}

/** Every release of a repository, newest first. Empty when it has none. */
export async function listReleases(url: string): Promise<Release[]> {
	const result = await run('git', ['ls-remote', '--tags', '--refs', url], {
		timeoutMs: remoteTimeoutMs,
	});
	if (result.code !== 0) throw unreachable(url, result.stderr);
	return parseTags(result.stdout);
}

/** The branch a repository opens on, and its newest commit. */
export async function defaultBranch(url: string): Promise<{ branch: string; commit: string }> {
	const result = await run('git', ['ls-remote', '--symref', url, 'HEAD'], {
		timeoutMs: remoteTimeoutMs,
	});
	if (result.code !== 0) throw unreachable(url, result.stderr);

	const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(result.stdout)?.[1];
	const commit = /^([0-9a-f]{40})\s+HEAD$/m.exec(result.stdout)?.[1];
	if (!branch || !commit) {
		throw new CliError(`${url} has nothing in it yet.`, {
			hint: 'An extension has to have at least one commit before it can be installed.',
		});
	}
	return { branch, commit };
}

/**
 * Reads one file from a repository at a tag or branch. Undefined when it is not there.
 *
 * GitHub serves any file of a public repository as plain text, which takes one request.
 * Anywhere else, and for a private one, the repository is cloned, as little of it as git
 * allows, into a folder thrown away after.
 */
export async function readRemoteFile(
	url: string,
	ref: string,
	path: string,
): Promise<string | undefined> {
	const repo = githubRepo(url);
	if (repo) {
		try {
			const response = await fetch(
				`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${path}`,
				{
					headers: { 'user-agent': `smartify-os-cli/${cliVersion}` },
					signal: AbortSignal.timeout(remoteTimeoutMs),
				},
			);
			if (response.ok) return await response.text();
			// A 404 is also what a private repository answers. git may still get in, with
			// whatever login this machine has for it, so it gets asked either way.
			await response.body?.cancel();
		} catch {
			// Fall through to git, which might be let through where this was not.
		}
	}

	return await withClone(url, ref, [path], async (dir) => {
		const file = Bun.file(join(dir, path));
		return (await file.exists()) ? await file.text() : undefined;
	});
}

/**
 * Checks out just the given folders of a repository at a tag or branch, hands the checkout
 * to `use`, and deletes it again afterwards.
 */
export async function withClone<T>(
	url: string,
	ref: string,
	paths: string[],
	use: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), 'smartify-os-clone-'));
	try {
		const clone = await run(
			'git',
			[
				'clone',
				'--quiet',
				'--depth',
				'1',
				'--branch',
				ref,
				'--filter=blob:none',
				'--sparse',
				url,
				dir,
			],
			{ timeoutMs: 5 * remoteTimeoutMs },
		);
		if (clone.code !== 0) throw unreachable(url, clone.stderr);

		// Anchored at the top, so `/pubspec.yaml` is not every pubspec.yaml in the repository.
		const patterns = paths.map((path) => `/${path.replace(/^\/+/, '')}`);
		const sparse = await run('git', ['sparse-checkout', 'set', '--no-cone', ...patterns], {
			cwd: dir,
			timeoutMs: 5 * remoteTimeoutMs,
		});
		if (sparse.code !== 0) throw unreachable(url, sparse.stderr);

		return await use(dir);
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

/** The newest commit on one branch of a repository. */
export async function branchCommit(url: string, branch: string): Promise<string | undefined> {
	const result = await run('git', ['ls-remote', url, `refs/heads/${branch}`], {
		timeoutMs: remoteTimeoutMs,
	});
	if (result.code !== 0) throw unreachable(url, result.stderr);
	return /^([0-9a-f]{40})\s/m.exec(result.stdout)?.[1];
}
