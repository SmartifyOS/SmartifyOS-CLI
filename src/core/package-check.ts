import { parseAndroid } from './android/needs.ts';
import { readDownloads } from './downloads/list.ts';
import { checkPackage, readSmartifyOsSection } from './linux/collect.ts';
import type { ListProblem } from './linux/lists.ts';

/**
 * Checks everything one package says under `smartify_os:` in its pubspec: what it needs on
 * Linux and on Android, and what it downloads onto the car. For the commands that bring a
 * package into a car or release one, which reject a mistake before it reaches a car.
 */
export async function checkPackageLists(root: string, packageName: string): Promise<ListProblem[]> {
	const section = await readSmartifyOsSection(root);
	if (section === undefined) return [];
	const requester = { name: packageName, title: packageName };
	return [
		...(await checkPackage(root, packageName)),
		...parseAndroid(section).problems,
		...(await readDownloads(root, requester, section)).problems,
	];
}
