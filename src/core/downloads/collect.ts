import { readExtensionPackage, readExtensionSettings } from '../extension/settings.ts';
import { type NeedProblem, readListingPackages } from '../linux/collect.ts';
import { type CarState, findEntry } from '../project/car.ts';
import { carFiles } from '../project/find.ts';
import { type DownloadList, readDownloads, type WrittenSettings } from './list.ts';

/** Everything the packages of a car's app download, and what its lib/main.dart sets for them. */
export interface CarDownloads {
	lists: DownloadList[];
	/** What lib/main.dart writes for the settings items are picked by, by package. */
	settings: Map<string, WrittenSettings>;
	problems: NeedProblem[];
}

/** Reads what every package the car's app resolved downloads. Pub has to have run. */
export async function collectDownloads(state: CarState): Promise<CarDownloads> {
	const lists: DownloadList[] = [];
	const problems: NeedProblem[] = [];
	for (const { requester, root, section } of await readListingPackages(state.app.dir)) {
		const read = await readDownloads(root, requester, section);
		for (const problem of read.problems) problems.push({ ...problem, requester });
		if (read.list && read.list.items.length > 0) lists.push(read.list);
	}

	const settings = new Map<string, WrittenSettings>();
	const main = await Bun.file(carFiles(state.app).main)
		.text()
		.catch(() => undefined);
	for (const list of lists) {
		if (!main || !list.items.some((item) => item.setting)) continue;
		const written = await writtenSettings(state, list.requester.name, main);
		if (written) settings.set(list.requester.name, written);
	}
	return { lists, settings, problems };
}

/** Internal: what lib/main.dart gives one extension's settings, as code. */
async function writtenSettings(
	state: CarState,
	packageName: string,
	main: string,
): Promise<WrittenSettings | undefined> {
	const root = state.extensions.find((extension) => extension.name === packageName)?.root;
	if (!root) return undefined;
	const entry = await findEntry(packageName, root);
	if (!entry) return undefined;
	try {
		const read = readExtensionSettings(main, entry, await readExtensionPackage(root, entry));
		const code: Record<string, string> = {};
		for (const [name, value] of Object.entries(read.values)) {
			if (typeof value === 'string') code[name] = value;
			else if (Array.isArray(value)) code[name] = value.map(String).join(', ');
		}
		for (const [name, written] of Object.entries(read.code)) code[name] = written.code;
		const collections = new Set(
			read.fields
				.filter((field) => ['array', 'map', 'ids', 'list'].includes(field.type))
				.map((field) => field.key),
		);
		return { code, collections };
	} catch {
		// Settings the CLI cannot read are as good as not written: the defaults apply.
		return undefined;
	}
}
