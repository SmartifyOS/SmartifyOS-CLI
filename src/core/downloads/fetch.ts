import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { stateDir } from '../paths.ts';
import { run } from '../process.ts';
import { type DownloadItem, type DownloadList, type DownloadPart, itemPath } from './list.ts';

/**
 * Downloading what goes on a car on this computer, and keeping it, so the next car or the
 * next update does not download it again.
 *
 * An item is kept in `~/.smartify-os/cache/downloads/<its path on the car>/`, made complete
 * as `<folder>.part` first and renamed, exactly as the car keeps it. Next to it a
 * `<folder>.json` says what it was downloaded from, so an item whose files change in a newer
 * version of its package is downloaded again.
 */

/** Where downloads are kept on this computer. */
export function downloadsCache(): string {
	return join(stateDir(), 'cache', 'downloads');
}

/** Where one item is kept. */
export function cachedPath(list: DownloadList, item: DownloadItem): string {
	return join(downloadsCache(), ...itemPath(list, item).split('/'));
}

/** Internal: what an item is downloaded from, which decides whether the kept one still is it. */
function stampOf(item: DownloadItem): string {
	return JSON.stringify({ parts: item.parts });
}

/** Whether an item is kept on this computer, complete and from what it is downloaded from now. */
export async function isCached(list: DownloadList, item: DownloadItem): Promise<boolean> {
	const path = cachedPath(list, item);
	if (!existsSync(path)) return false;
	const stamp = Bun.file(`${path}.json`);
	return (await stamp.exists()) && (await stamp.text()) === stampOf(item);
}

/** How far a download is: bytes so far of roughly how many. */
export type OnBytes = (received: number) => void;

/**
 * Downloads an item into the cache, unless it is there already.
 *
 * @returns its folder.
 * @throws {CliError} saying which file did not come, when one did not.
 */
export async function fetchItem(
	list: DownloadList,
	item: DownloadItem,
	onBytes?: OnBytes,
): Promise<string> {
	const path = cachedPath(list, item);
	if (await isCached(list, item)) return path;

	const partial = `${path}.part`;
	await rm(partial, { recursive: true, force: true });
	await mkdir(partial, { recursive: true });
	let received = 0;
	const counted = (count: number) => {
		received += count;
		onBytes?.(received);
	};
	try {
		for (const part of item.parts) await fetchPart(part, partial, counted);
		await rm(path, { recursive: true, force: true });
		await rename(partial, path);
		await Bun.write(`${path}.json`, stampOf(item));
		return path;
	} catch (error) {
		await rm(partial, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

/** Internal: one part of an item, into its folder. */
async function fetchPart(
	part: DownloadPart,
	into: string,
	onBytes: (count: number) => void,
): Promise<void> {
	switch (part.kind) {
		case 'file':
			await fetchFile(part.url, join(into, ...part.path.split('/')), onBytes);
			return;
		case 'huggingFace':
			for (const path of await listHuggingFace(part.repo, part.folder, part.revision)) {
				await fetchFile(
					`https://huggingface.co/${part.repo}/resolve/${part.revision}/${path.split('/').map(encodeURIComponent).join('/')}`,
					join(into, ...path.split('/')),
					onBytes,
				);
			}
			return;
		case 'archive': {
			const archive = join(into, '.archive');
			const unpacked = join(into, '.unpacked');
			await fetchFile(part.url, archive, onBytes);
			await mkdir(unpacked, { recursive: true });
			// tar on every system unpacks .tar.gz, .tar.bz2 and .tar.xz without being told which.
			const result = await run('tar', ['-xf', archive, '-C', unpacked, ...Object.keys(part.keep)]);
			if (result.code !== 0) {
				throw new CliError(`${part.url} could not be unpacked.`, {
					hint: result.stderr.trim().split('\n').slice(-5).join('\n'),
				});
			}
			for (const [from, to] of Object.entries(part.keep)) {
				const target = join(into, ...to.split('/'));
				await mkdir(dirname(target), { recursive: true });
				await rename(join(unpacked, ...from.split('/')), target);
			}
			await rm(archive, { force: true });
			await rm(unpacked, { recursive: true, force: true });
			return;
		}
	}
}

/** Internal: downloads one file, streamed to disk, since one can be most of a gigabyte. */
async function fetchFile(
	url: string,
	path: string,
	onBytes: (count: number) => void,
): Promise<void> {
	let response: Response;
	try {
		response = await fetch(url, { redirect: 'follow' });
	} catch (error) {
		throw offline(url, error);
	}
	if (!response.ok || !response.body) {
		throw new CliError(`${url} could not be downloaded (${response.status}).`, {
			hint: 'It may have moved. Tell the author of the extension it is for.',
		});
	}
	await mkdir(dirname(path), { recursive: true });
	const writer = Bun.file(path).writer();
	// A reader rather than `for await`, which Bun fails on for some responses.
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			writer.write(value);
			onBytes(value.byteLength);
		}
	} catch (error) {
		throw offline(url, error);
	} finally {
		await writer.end();
	}
}

/** Internal: every file in a folder of a Hugging Face repository, page by page. */
async function listHuggingFace(repo: string, folder: string, revision: string): Promise<string[]> {
	const paths: string[] = [];
	let next: string | undefined =
		`https://huggingface.co/api/models/${repo}/tree/${revision}/${folder}?recursive=true`;
	while (next) {
		let response: Response;
		try {
			response = await fetch(next);
		} catch (error) {
			throw offline(next, error);
		}
		if (!response.ok) {
			throw new CliError(
				`What is in ${folder} of ${repo} could not be listed (${response.status}).`,
				{
					hint: 'It may have moved. Tell the author of the extension it is for.',
				},
			);
		}
		for (const entry of (await response.json()) as { type?: string; path?: string }[]) {
			if (entry.type === 'file' && typeof entry.path === 'string') paths.push(entry.path);
		}
		next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
	}
	return paths;
}

function offline(url: string, error: unknown): CliError {
	return new CliError(`${new URL(url).host} could not be reached.`, {
		hint: `Downloading needs the internet. ${error instanceof Error ? error.message : ''}`.trim(),
	});
}

/** Every file in a folder, relative to it, with `/` between folders. */
export async function filesIn(folder: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const parent = entry.parentPath ?? folder;
		found.push(
			join(parent, entry.name)
				.slice(folder.length + 1)
				.split(/[\\/]/)
				.join('/'),
		);
	}
	return found.sort();
}
