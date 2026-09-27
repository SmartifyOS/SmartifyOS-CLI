import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Finding the USB sticks and other removable drives plugged into this computer, so nobody
 * has to know where their system mounts them.
 *
 * This only offers them. It cannot always tell a USB stick from a second internal drive,
 * so the user always picks, and can always type a folder of their own instead.
 */

export interface Drive {
	/** Where it is mounted. */
	path: string;
	/** What a person calls it, usually the name it was given when formatted. */
	label: string;
}

/** The drives plugged in right now, by name. Never throws, an empty list at worst. */
export async function listDrives(): Promise<Drive[]> {
	try {
		const found =
			process.platform === 'darwin'
				? await macDrives()
				: process.platform === 'win32'
					? windowsDrives()
					: await linuxDrives();
		return found.sort((a, b) => a.label.localeCompare(b.label));
	} catch {
		return [];
	}
}

/** Internal: everything in /Volumes except the startup disk, which is a link to `/`. */
async function macDrives(): Promise<Drive[]> {
	const drives: Drive[] = [];
	for (const name of await readdir('/Volumes')) {
		if (name.startsWith('.')) continue;
		const path = join('/Volumes', name);
		try {
			if (realpathSync(path) === '/') continue;
		} catch {
			continue;
		}
		drives.push({ path, label: name });
	}
	return drives;
}

/**
 * Internal: whatever is mounted where desktops put removable drives, `/media/<user>`,
 * `/run/media/<user>` or `/media`, read from the mount table so an empty folder there is
 * never offered.
 */
async function linuxDrives(): Promise<Drive[]> {
	const user = userInfo().username;
	const places = [`/media/${user}/`, `/run/media/${user}/`, '/media/', '/mnt/'];
	const mounts = await readFile('/proc/self/mounts', 'utf8');
	const drives: Drive[] = [];
	for (const line of mounts.split('\n')) {
		// Spaces in a mount point are written as \040.
		const path = (line.split(' ')[1] ?? '').replace(/\\040/g, ' ');
		if (!places.some((place) => path.startsWith(place))) continue;
		if (drives.some((drive) => drive.path === path)) continue;
		drives.push({ path, label: basename(path) });
	}
	return drives;
}

/** Internal: every drive letter after C that is there. */
function windowsDrives(): Drive[] {
	const drives: Drive[] = [];
	for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
		const path = `${letter}:\\`;
		if (existsSync(path)) drives.push({ path, label: `${letter}:` });
	}
	return drives;
}
