import { join } from 'node:path';
import {
	addChangelogEntry,
	nextVersion,
	type ReleaseKind,
	setVersion,
} from '../../core/extension/release.ts';
import { normalizeRepoUrl } from '../../core/git.ts';
import { lastLines, run, runOrThrow } from '../../core/process.ts';
import { requireExtension } from '../../core/project/find.ts';
import { parsePubspec } from '../../core/pubspec/read.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { step } from '../../ui/project.ts';
import { confirm, isInteractive, select, text } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { findSmartifyOs } from './smartify-os.ts';

/**
 * Releases a new version of the extension: the version number, the changelog, the tests, a
 * commit, a tag and a push, the steps EXTENSIONS.md describes for doing it by hand.
 */
export const extensionReleaseCommand: Command = {
	name: 'release',
	summary: 'Release a new version of your extension',
	description:
		"Releases a new version of the extension you are in: raises its version, adds what changed to CHANGELOG.md, runs its tests, then commits, tags and pushes it to GitHub, where cars can update to it. Everything you changed since the last release goes in. Run it in your extension's folder.",
	examples: [
		`${binaryName} extension release`,
		`${binaryName} extension release --fix --notes "The card shows the right time again"`,
	],
	flags: {
		fix: { type: 'boolean', describe: 'It fixes something (0.1.0 becomes 0.1.1)' },
		feature: { type: 'boolean', describe: 'It adds something new (0.1.0 becomes 0.2.0)' },
		notes: { type: 'string', describe: 'What changed, for CHANGELOG.md, one line' },
		repository: { type: 'string', describe: 'Its GitHub address, when it is not on GitHub yet' },
	},
	async run({ flags }) {
		const extension = await requireExtension();
		const dir = extension.dir;
		intro('Release an extension');

		if ((await git(dir, ['rev-parse', '--git-dir'])).code !== 0) {
			throw new CliError('This extension is not a git repository.', {
				hint: `Extensions made with ${theme.code(`${binaryName} extension create`)} are. Run ${theme.code('git init')} and commit it once.`,
			});
		}

		const pubspecPath = join(dir, 'pubspec.yaml');
		const pubspecText = await Bun.file(pubspecPath).text();
		const current = String(parsePubspec(pubspecText, 'pubspec.yaml').version ?? '0.0.0');

		const remote = await ensureRemote(dir, flags.repository);

		// A release made last time whose push failed: finish that one instead of making another.
		const lastTag = `v${current}`;
		const tagged =
			(await git(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${lastTag}`])).code === 0;
		if (tagged && !(await isPushed(dir, remote, lastTag))) {
			log.info(`${current} was released on this computer, but never reached GitHub.`);
			await push(dir, remote, lastTag);
			outro(`Released ${theme.success(theme.strong(current))}`);
			return;
		}

		const changed = (await git(dir, ['status', '--porcelain'])).stdout.trim() !== '';
		const atTag =
			tagged &&
			(await git(dir, ['describe', '--exact-match', '--tags', 'HEAD'])).stdout.trim() === lastTag;
		if (atTag && !changed) {
			outro(`Nothing changed since ${current} ${theme.dim('(nothing was released)')}`);
			return;
		}

		// The very first release is the version it was made with, whose changelog entry the
		// template already wrote.
		const first = (await git(dir, ['tag', '--list', 'v*'])).stdout.trim() === '';
		const kind = first ? undefined : await askKind(flags.fix === true, flags.feature === true);
		const version = kind ? nextVersion(current, kind) : current;
		const notes = kind ? await askNotes(flags.notes, kind) : undefined;
		if (first) log.info(`This is its first release, so it goes out as ${theme.strong(version)}.`);

		const go =
			flags.yes === true ||
			(await confirm({
				message: first ? `Release ${version}?` : `Release ${version} (now ${current})?`,
				initialValue: true,
			}));
		if (!go) {
			outro(`Left as it is ${theme.dim('(nothing was changed)')}`);
			return;
		}

		await findSmartifyOs(dir);
		await step(
			'Running its tests',
			async () => {
				const result = await run('flutter', ['test'], { cwd: dir });
				if (result.code !== 0) {
					throw new CliError('Its tests do not pass, so nothing was released.', {
						hint: `Fix them first, ${theme.code('flutter test')} shows them.\n${lastLines(`${result.stdout}\n${result.stderr}`)}`,
					});
				}
			},
			() => 'Its tests pass',
		);

		const changelogPath = join(dir, 'CHANGELOG.md');
		const changelog = Bun.file(changelogPath);
		const changelogText = (await changelog.exists()) ? await changelog.text() : '';
		await Bun.write(pubspecPath, setVersion(pubspecText, version));
		if (notes) await Bun.write(changelogPath, addChangelogEntry(changelogText, version, notes));
		else if (
			!new RegExp(`^##\\s+\\[?v?${version.replaceAll('.', '\\.')}\\b`, 'm').test(changelogText)
		) {
			await Bun.write(changelogPath, addChangelogEntry(changelogText, version, ['First release']));
		}

		await step(`Saving ${version}`, async () => {
			const failure = { message: `${version} could not be committed.` };
			await runOrThrow('git', ['add', '--all'], failure, { cwd: dir });
			// A first release of an extension nobody has touched since it was made has nothing
			// to commit, and is tagged as it is.
			const staged = (await git(dir, ['diff', '--cached', '--quiet'])).code !== 0;
			if (staged) {
				await runOrThrow('git', ['commit', '--quiet', '--message', `Release ${version}`], failure, {
					cwd: dir,
				});
			}
			await runOrThrow('git', ['tag', `v${version}`], failure, { cwd: dir });
		});

		await push(dir, remote, `v${version}`);
		outro(`Released ${theme.success(theme.strong(version))}. Cars can update to it now.`);
	},
};

function git(dir: string, args: string[]) {
	return run('git', args, { cwd: dir });
}

/** Internal: a fix or something new, from the flags or by asking. */
async function askKind(fix: boolean, feature: boolean): Promise<ReleaseKind> {
	if (fix && feature) {
		throw new CliError('A release is either a fix or something new, not both.', {
			hint: `Pass ${theme.code('--feature')} when it adds anything at all.`,
		});
	}
	if (fix) return 'fix';
	if (feature) return 'feature';
	return await select<ReleaseKind>({
		message: 'What kind of change is it?',
		options: [
			{ value: 'fix', label: 'A fix', hint: 'something works again' },
			{ value: 'feature', label: 'Something new', hint: 'it can do more than before' },
		],
	});
}

/** Internal: the changelog line, from the flag or by asking. */
async function askNotes(given: unknown, kind: ReleaseKind): Promise<string[]> {
	if (typeof given === 'string' && given.trim()) return [given.trim()];
	if (!isInteractive()) return [kind === 'fix' ? 'Fixes' : 'New features'];
	const answer = await text({
		message: 'What changed? One line for CHANGELOG.md, people read it before they update.',
		placeholder:
			kind === 'fix' ? 'The card shows the right time again' : 'A setting to hide the card',
		validate: (value) => (value?.trim() ? undefined : 'Say what changed, in a few words.'),
	});
	return [answer.trim()];
}

/**
 * Internal: the remote to push to. An extension that is not on GitHub yet gets the address
 * the user gives, of a repository they made there.
 */
async function ensureRemote(dir: string, given: unknown): Promise<string> {
	const existing = (await git(dir, ['remote'])).stdout.split('\n').map((line) => line.trim());
	if (existing.includes('origin')) return 'origin';
	if (existing[0]) return existing[0];

	let url = typeof given === 'string' ? given : undefined;
	if (!url) {
		log.info(
			'It is not on GitHub yet. Make an empty repository on https://github.com/new with the same name as its folder, then paste its address here.',
		);
		url = await text({
			message: 'The GitHub address of the new repository',
			placeholder: 'https://github.com/you/smartify_os_dashcam',
			validate: (value) => (value?.trim() ? undefined : 'The address is needed to put it there.'),
		});
	}
	await runOrThrow(
		'git',
		['remote', 'add', 'origin', normalizeRepoUrl(url)],
		{
			message: 'The GitHub address could not be saved.',
		},
		{ cwd: dir },
	);
	return 'origin';
}

/** Internal: whether a tag is on the remote already. */
async function isPushed(dir: string, remote: string, tag: string): Promise<boolean> {
	const result = await git(dir, ['ls-remote', '--tags', remote, `refs/tags/${tag}`]);
	return result.code === 0 && result.stdout.trim() !== '';
}

/** Internal: pushes the branch and the tag, saying how to finish when it cannot. */
async function push(dir: string, remote: string, tag: string): Promise<void> {
	await step('Sending it to GitHub', async () => {
		const branch = await git(dir, ['push', '--quiet', '--set-upstream', remote, 'HEAD']);
		const tagged = branch.code === 0 ? await git(dir, ['push', '--quiet', remote, tag]) : branch;
		if (tagged.code !== 0) {
			throw new CliError(
				`${tag.slice(1)} is saved on this computer, but could not be sent to GitHub.`,
				{
					hint: `${lastLines(tagged.stderr, 5)}\nOnce that is sorted, run ${theme.code(`${binaryName} extension release`)} again to send it.`,
				},
			);
		}
	});
}
