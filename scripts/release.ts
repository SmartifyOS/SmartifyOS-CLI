#!/usr/bin/env bun
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import { $ } from 'bun';
import color from 'picocolors';

/**
 * Cuts a release, for the maintainer. One command that walks through all of it:
 *
 *   bun run release            asks for the version and a summary, then releases
 *   bun run release --dry-run  the same questions, and shows what it would do instead
 *
 * 1. Checks the repo is ready: on main, nothing uncommitted, up to date with GitHub, and
 *    `bun run check` passes.
 * 2. Asks for the version and an optional summary, and shows the release notes, made from
 *    the `feat:`, `fix:` and `refactor:` commits since the last tag.
 * 3. Sets the version in package.json, commits `chore: release vX`, and pushes it.
 * 4. Tags that commit `vX` with the release notes as the tag's message, and pushes the tag.
 *    That starts .github/workflows/release.yml, which builds everything and publishes the
 *    release with those notes.
 *
 * The same script lives in SmartifyOS-CLI and SmartifyOS-Editor. Keep them alike.
 */

const dryRun = process.argv.includes('--dry-run');
const root = (await $`git rev-parse --show-toplevel`.quiet().text()).trim();
$.cwd(root);

/** The commit types that go in the notes, under these headings, in this order. */
const sections = [
	{ type: 'feat', heading: 'New features', one: 'new feature', many: 'new features' },
	{ type: 'fix', heading: 'Fixes', one: 'fix', many: 'fixes' },
	{ type: 'refactor', heading: 'Refactors', one: 'refactor', many: 'refactors' },
] as const;

interface Commit {
	hash: string;
	type: string;
	subject: string;
}

/** Stops with a message, and a hint saying what to do about it. */
function fail(message: string, hint?: string): never {
	p.cancel(hint ? `${message}\n${color.dim(hint)}` : message);
	process.exit(1);
}

/** Internal: a prompt's answer, or the end of the run when it was cancelled. */
function answer<T>(value: T | symbol): Exclude<T, symbol> {
	if (p.isCancel(value)) fail('Cancelled, nothing was changed.');
	return value as Exclude<T, symbol>;
}

async function git(...args: string[]): Promise<string> {
	const result = await $`git ${args}`.nothrow().quiet();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed:\n${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString().trim();
}

interface Version {
	major: number;
	minor: number;
	patch: number;
	prerelease: string;
}

function parseVersion(text: string): Version | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
	if (!match) return undefined;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ?? '',
	};
}

/** Whether `a` comes after `b`. A prerelease comes before the release it leads up to. */
function isAfter(a: Version, b: Version): boolean {
	for (const key of ['major', 'minor', 'patch'] as const) {
		if (a[key] !== b[key]) return a[key] > b[key];
	}
	if (a.prerelease === b.prerelease) return false;
	if (!a.prerelease) return true;
	if (!b.prerelease) return false;
	return a.prerelease > b.prerelease;
}

/** The commits since `since` (every commit when there is no tag yet), merges left out. */
async function commitsSince(since: string | undefined): Promise<Commit[]> {
	const range = since ? [`${since}..HEAD`] : [];
	const log = await git('log', '--no-merges', '--format=%h%x1f%s', ...range);
	return log
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [hash = '', subject = ''] = line.split('\x1f');
			// `type: subject`, also taking `type(scope): subject` and `type!: subject`.
			const match = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(subject);
			return {
				hash,
				type: match?.[1]?.toLowerCase() ?? '',
				subject: match?.[2] ?? subject,
			};
		});
}

/** The release notes: the summary on top, then a list per kind of change. */
function releaseNotes(summary: string, commits: Commit[]): string {
	const parts: string[] = [];
	if (summary) parts.push(summary);
	for (const { type, heading } of sections) {
		const items = commits.filter((commit) => commit.type === type);
		if (items.length === 0) continue;
		const lines = items.map(
			(commit) =>
				`- ${commit.subject.charAt(0).toUpperCase()}${commit.subject.slice(1)} (${commit.hash})`,
		);
		parts.push(`## ${heading}\n\n${lines.join('\n')}`);
	}
	if (parts.length === 0) parts.push('Maintenance only, nothing changed that you would notice.');
	return `${parts.join('\n\n')}\n`;
}

/** The repository's page on GitHub, from the origin remote, or undefined when it is elsewhere. */
async function githubUrl(): Promise<string | undefined> {
	const remote = await git('remote', 'get-url', 'origin').catch(() => '');
	const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote);
	return match ? `https://github.com/${match[1]}` : undefined;
}

// 1. Is the repo ready?

const packageJson = await Bun.file(join(root, 'package.json')).text();
const name = (JSON.parse(packageJson) as { name: string }).name;
p.intro(
	`${color.bgCyan(color.black(' release '))} ${name}${dryRun ? color.dim(' (dry run)') : ''}`,
);

const branch = await git('branch', '--show-current');
if (branch !== 'main')
	fail(`You are on ${branch}.`, 'Releases are cut from main. Switch to it first.');

if (await git('status', '--porcelain')) {
	if (dryRun) p.log.warn('There are uncommitted changes. A real release would stop here.');
	else
		fail(
			'There are uncommitted changes.',
			'Commit or stash them first, a release is made from what is committed.',
		);
}

const spin = p.spinner();
spin.start('Asking GitHub for what is new');
try {
	await git('fetch', '--tags', '--quiet', 'origin', 'main');
} catch (error) {
	spin.error('Could not reach GitHub');
	fail(String(error instanceof Error ? error.message : error));
}
const behind = Number(await git('rev-list', '--count', 'HEAD..origin/main'));
if (behind > 0) {
	spin.error('GitHub has newer commits');
	fail(
		`main is ${behind} commit${behind === 1 ? '' : 's'} behind GitHub.`,
		'Pull first: git pull --rebase',
	);
}
spin.stop('Up to date with GitHub');

spin.start('Running bun run check');
const check = await $`bun run check`.nothrow().quiet();
if (check.exitCode !== 0) {
	spin.error('bun run check failed');
	p.log.error(`${check.stdout.toString()}${check.stderr.toString()}`.trim());
	fail('Fix what the check found, then run this again.');
}
spin.stop('bun run check passed');

// 2. Which version, and what changed?

const currentText = (JSON.parse(packageJson) as { version: string }).version;
const current = parseVersion(currentText);
if (!current) fail(`package.json has a version that is not x.y.z: ${currentText}`);

const lastTag = await git('describe', '--tags', '--abbrev=0', '--match', 'v*').catch(
	() => undefined,
);
const commits = await commitsSince(lastTag);
const counted = sections.map(({ type, one, many }) => ({
	one,
	many,
	count: commits.filter((commit) => commit.type === type).length,
}));
const notable = counted.reduce((sum, { count }) => sum + count, 0);

p.log.info(
	[
		`Now at ${color.bold(currentText)}${lastTag ? `, last tag ${lastTag}` : ', never released'}.`,
		commits.length === 0
			? 'No commits since then.'
			: `${commits.length} commit${commits.length === 1 ? '' : 's'} since: ${counted
					.map(({ one, many, count }) => `${count} ${count === 1 ? one : many}`)
					.join(', ')}, and ${commits.length - notable} left out of the notes.`,
	].join('\n'),
);
if (commits.length === 0) {
	const anyway = answer(await p.confirm({ message: 'Release anyway?', initialValue: false }));
	if (!anyway) fail('Nothing to release, nothing was changed.');
}

const base = { ...current, prerelease: '' };
const bumps = {
	patch: `${base.major}.${base.minor}.${base.patch + 1}`,
	minor: `${base.major}.${base.minor + 1}.0`,
	major: `${base.major + 1}.0.0`,
};
const hasFeatures = commits.some((commit) => commit.type === 'feat');
// The first release can be the version package.json has already.
const firstRelease = lastTag === undefined;
const finishPrerelease = `${base.major}.${base.minor}.${base.patch}`;
const picked = answer(
	await p.select({
		message: 'Which version?',
		initialValue: firstRelease ? currentText : hasFeatures ? bumps.minor : bumps.patch,
		options: [
			...(firstRelease
				? [{ value: currentText, label: currentText, hint: 'the first release, as it is now' }]
				: []),
			// A prerelease is finished by releasing the version it leads up to.
			...(current.prerelease && !firstRelease
				? [{ value: finishPrerelease, label: finishPrerelease, hint: 'finish the prerelease' }]
				: []),
			{ value: bumps.patch, label: bumps.patch, hint: 'only fixes' },
			{ value: bumps.minor, label: bumps.minor, hint: 'something new' },
			{ value: bumps.major, label: bumps.major, hint: 'a big step' },
			{ value: 'other', label: 'Another version' },
		],
	}),
);

const existingTags = new Set((await git('tag', '--list', 'v*')).split('\n').filter(Boolean));
const version =
	picked !== 'other'
		? picked
		: answer(
				await p.text({
					message: 'Which version? (x.y.z, or x.y.z-beta.1)',
					placeholder: bumps.minor,
					validate(value) {
						const parsed = parseVersion(value ?? '');
						if (!parsed) return 'Write it as x.y.z, like 1.2.3, or 1.2.3-beta.1.';
						if (!firstRelease && !isAfter(parsed, current)) {
							return `It has to come after ${currentText}.`;
						}
						return undefined;
					},
				}),
			).trim();
const tag = `v${version}`;
if (existingTags.has(tag)) fail(`${tag} exists already.`, 'Pick another version.');

const summary =
	answer(
		await p.text({
			message: 'A short summary for the top of the release notes? (optional)',
			placeholder: 'Leave empty to skip',
		}),
	)?.trim() ?? '';

const notes = releaseNotes(summary, commits);
p.note(notes.trimEnd(), `Release notes for ${tag}`);

// 3 and 4. Release it.

const bump = version !== currentText;
const steps: { text: string; run: () => Promise<unknown> }[] = [];
if (bump) {
	steps.push({
		text: `Set package.json to ${version}`,
		async run() {
			// Only the version line is replaced, so the rest of the file stays as it is.
			const updated = packageJson.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
			await Bun.write(join(root, 'package.json'), updated);
		},
	});
	steps.push({
		text: `Commit "chore: release ${tag}" and push it to main`,
		async run() {
			await git('add', 'package.json');
			await git('commit', '--quiet', '-m', `chore: release ${tag}`);
			await git('push', '--quiet', 'origin', 'main');
		},
	});
} else {
	steps.push({
		text: 'Push main, so GitHub has the commit the tag points at',
		run: () => git('push', '--quiet', 'origin', 'main'),
	});
}
steps.push({
	text: `Tag it ${tag} with these notes and push the tag, which starts the release workflow`,
	async run() {
		const file = join(tmpdir(), `release-notes-${tag}.md`);
		writeFileSync(file, notes);
		try {
			// Verbatim, or git would take the markdown headings for comments and drop them.
			await git('tag', '--annotate', '--cleanup=verbatim', '--file', file, tag);
		} finally {
			rmSync(file, { force: true });
		}
		await git('push', '--quiet', 'origin', tag);
	},
});

if (dryRun) {
	p.log.message(steps.map((step, index) => `${index + 1}. ${step.text}`).join('\n'));
	p.outro('Dry run, nothing was changed.');
	process.exit(0);
}

const go = answer(
	await p.confirm({ message: `Release ${tag}? This pushes to GitHub.`, initialValue: true }),
);
if (!go) fail('Cancelled, nothing was changed.');

for (const [index, step] of steps.entries()) {
	spin.start(step.text);
	try {
		await step.run();
		spin.stop(step.text);
	} catch (error) {
		spin.error(`Failed: ${step.text}`);
		// Says what was done already, so it can be finished by hand.
		const done = steps.slice(0, index).map((earlier) => `  ${earlier.text}`);
		fail(
			String(error instanceof Error ? error.message : error),
			done.length > 0 ? `Done before it stopped:\n${done.join('\n')}` : 'Nothing was changed.',
		);
	}
}

const url = await githubUrl();
p.outro(
	url
		? `${tag} is on its way. Follow the build at ${color.cyan(`${url}/actions`)}\nThe release shows up at ${color.cyan(`${url}/releases/tag/${tag}`)}`
		: `${tag} is on its way.`,
);
