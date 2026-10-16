import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliError } from '../utils/errors.ts';
import { withClone } from './git.ts';
import { coreRepoUrl } from './smartify-os.ts';

/**
 * Copying a folder out of the SmartifyOS repository to start something new from: the
 * extension template, the app template, or the Miata app.
 */

/** What is never copied: what a machine made, not what the folder is. */
const leftOut = new Set([
	'pubspec_overrides.yaml',
	'pubspec.lock',
	'.dart_tool',
	'build',
	'.DS_Store',
	'.git',
]);

/**
 * Copies a folder, passing the text of every file and every file and folder name through
 * `rename` on the way. Without `rename` everything is copied as it is.
 */
export async function copyFolder(
	from: string,
	to: string,
	rename?: (text: string) => string,
): Promise<void> {
	await mkdir(to, { recursive: true });

	for (const entry of await readdir(from, { withFileTypes: true })) {
		if (leftOut.has(entry.name)) continue;
		const source = join(from, entry.name);
		const target = join(to, rename ? rename(entry.name) : entry.name);

		if (entry.isDirectory()) {
			await copyFolder(source, target, rename);
			continue;
		}

		const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
		// A binary file (a picture, a font) is copied as it is rather than mangled.
		if (!rename || bytes.includes(0)) await Bun.write(target, bytes);
		else await Bun.write(target, rename(new TextDecoder().decode(bytes)));
	}
}

/**
 * Checks out one folder of the SmartifyOS repository at a tag or branch and hands it to
 * `use`, which copies whatever it needs out of it before it is deleted again.
 *
 * @throws {CliError} `missing` when that SmartifyOS does not have the folder.
 */
export async function withCoreFolder<T>(
	ref: string,
	folder: string,
	missing: CliError,
	use: (dir: string) => Promise<T>,
): Promise<T> {
	return await withClone(coreRepoUrl(), ref, [folder], async (dir) => {
		const found = join(dir, folder);
		if (!(await Bun.file(join(found, 'pubspec.yaml')).exists())) throw missing;
		return await use(found);
	});
}
