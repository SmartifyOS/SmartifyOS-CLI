import { lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Deletes `path` and everything in it, like `rm -rf`, for a USB stick.
 *
 * Use it instead of `rm(path, { recursive: true })` for anything on a stick. A Mac keeps a
 * hidden `._<name>` file next to every file on an exFAT or FAT stick and deletes it along
 * with the file, so it is gone again by the time a recursive delete reaches it. Bun's `rm`
 * then stops halfway without a word (`force` takes the missing file for the folder being
 * gone already), leaving the folder there. This skips whatever has vanished on its own and
 * goes on. Nothing there at all is fine too.
 */
export async function removeTree(path: string): Promise<void> {
	let isFolder: boolean;
	try {
		isFolder = (await lstat(path)).isDirectory();
	} catch (error) {
		if (isGone(error)) return;
		throw error;
	}
	try {
		if (isFolder) {
			for (const name of await readdir(path)) await removeTree(join(path, name));
			await rmdir(path);
		} else {
			await unlink(path);
		}
	} catch (error) {
		if (!isGone(error)) throw error;
	}
}

function isGone(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
