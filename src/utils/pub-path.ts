import { isAbsolute, relative, sep } from 'node:path';

/**
 * How a folder is written in a pubspec: relative to the pubspec's own folder while the two
 * are close, like `../smartify_os_dashcam`, and absolute once getting there would climb
 * further than that, or across drives, where a relative path is nothing anyone can read.
 * Always with forward slashes, which pub reads on every system.
 */
export function pubPath(from: string, to: string): string {
	const rel = relative(from, to);
	const climbs = rel.split(sep).filter((part) => part === '..').length;
	const path = isAbsolute(rel) || climbs > 2 ? to : rel || '.';
	return path.split(sep).join('/');
}
