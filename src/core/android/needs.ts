import {
	appTitle,
	type NeedProblem,
	type Requester,
	readListingPackages,
} from '../linux/collect.ts';
import { asMap, type ListProblem, type Report, readStrings, unknownKeys } from '../linux/lists.ts';

/**
 * What a package needs in the car's Android project: the `android:` key under `smartify_os:`
 * in its pubspec.yaml, next to `linux:`.
 *
 * ```yaml
 * smartify_os:
 *   android:
 *     minSdk: 28
 *     permissions:
 *       - android.permission.RECORD_AUDIO
 * ```
 *
 * A driver never opens the `android/` folder, so whatever a package needs there is written by
 * the CLI (src/core/android/project.ts). Like the Linux lists, nothing in here throws: a broken
 * entry is left out and reported.
 */

/** What one package lists for Android. */
export interface AndroidLists {
	/** The oldest Android it runs on, as an API level, undefined when it does not mind. */
	minSdk: number | undefined;
	/** Full permission names, `android.permission.RECORD_AUDIO`. */
	permissions: string[];
}

/** One permission, and every package that asked for it. */
export interface PermissionNeed {
	name: string;
	requesters: Requester[];
}

/** What the car's Android project needs, merged from every package. */
export interface AndroidNeeds {
	/** The highest `minSdk` asked for, since every package has to run. Null when none asks. */
	minSdk: { level: number; requesters: Requester[] } | null;
	permissions: PermissionNeed[];
	problems: NeedProblem[];
}

/** API levels a `minSdk` can sensibly be: Android 5 up to well past anything there is today. */
const sdkLevels = { lowest: 21, highest: 60 };

/** A permission's full name. Android's own are `android.permission.` and capitals. */
const permissionName = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** Reads the `android:` key of one package's `smartify_os:`. */
export function parseAndroid(section: unknown): { lists: AndroidLists; problems: ListProblem[] } {
	const lists: AndroidLists = { minSdk: undefined, permissions: [] };
	const problems: ListProblem[] = [];
	const problem: Report = (kind, path, message) => problems.push({ kind, path, message });

	const root = asMap(section, 'smartify_os', problem);
	const android = root && asMap(root.android, 'smartify_os.android', problem);
	if (!android) return { lists, problems };
	unknownKeys(android, ['minSdk', 'permissions'], 'smartify_os.android', problem);

	if (android.minSdk !== undefined && android.minSdk !== null) {
		const level = android.minSdk;
		if (
			typeof level === 'number' &&
			Number.isInteger(level) &&
			level >= sdkLevels.lowest &&
			level <= sdkLevels.highest
		) {
			lists.minSdk = level;
		} else {
			problem(
				'invalid',
				'smartify_os.android.minSdk',
				`minSdk has to be an Android API level, a whole number like 28 (Android 9), not ${JSON.stringify(level)}.`,
			);
		}
	}

	for (const { value, path } of readStrings(
		android.permissions,
		'smartify_os.android.permissions',
		problem,
	)) {
		// RECORD_AUDIO on its own is one of Android's.
		const name = /^[A-Z][A-Z0-9_]*$/.test(value) ? `android.permission.${value}` : value;
		if (permissionName.test(name)) {
			if (!lists.permissions.includes(name)) lists.permissions.push(name);
		} else {
			problem(
				'invalid',
				path,
				`${value} is not a permission name. Write it as Android does, like android.permission.RECORD_AUDIO.`,
			);
		}
	}
	return { lists, problems };
}

/** Merges what every package asked for. */
export function mergeAndroid(
	found: { requester: Requester; lists: AndroidLists; problems: ListProblem[] }[],
): AndroidNeeds {
	let minSdk: AndroidNeeds['minSdk'] = null;
	const permissions = new Map<string, PermissionNeed>();
	const problems: NeedProblem[] = [];

	for (const { requester, lists, problems: own } of found) {
		if (lists.minSdk !== undefined) {
			if (!minSdk || lists.minSdk > minSdk.level) {
				minSdk = { level: lists.minSdk, requesters: [requester] };
			} else if (lists.minSdk === minSdk.level) {
				minSdk.requesters.push(requester);
			}
		}
		for (const name of lists.permissions) {
			const need = permissions.get(name) ?? { name, requesters: [] };
			if (!need.requesters.some((r) => r.name === requester.name)) need.requesters.push(requester);
			permissions.set(name, need);
		}
		for (const problem of own) problems.push({ ...problem, requester });
	}

	return {
		minSdk,
		permissions: [...permissions.values()].sort((a, b) => a.name.localeCompare(b.name)),
		problems,
	};
}

/** What the car's Android project needs, from every package the car's app resolved. */
export async function collectAndroidNeeds(appDir: string): Promise<AndroidNeeds> {
	const found = (await readListingPackages(appDir)).map(({ requester, section }) => ({
		requester,
		...parseAndroid(section),
	}));
	return mergeAndroid(found);
}

/** Who asked, the way a comment in the Android project says it. */
export function requesterNames(requesters: Requester[]): string {
	const titles = requesters.map((r) => (r.title === appTitle ? 'your car' : r.title));
	if (titles.length <= 1) return titles.join('');
	return `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`;
}
