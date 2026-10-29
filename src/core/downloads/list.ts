import { join } from 'node:path';
import type { Requester } from '../linux/collect.ts';
import { type LinuxArch, linuxArchs } from '../linux/distro.ts';
import { asMap, type ListProblem, type Report, unknownKeys } from '../linux/lists.ts';

/**
 * What a package downloads onto the car while it runs (speech models, maps, anything too big
 * to ship in the app), so the CLI can put it on the car with the app instead: a car often has
 * no internet.
 *
 * A package names a JSON file in its pubspec.yaml, next to its Linux lists:
 *
 * ```yaml
 * smartify_os:
 *   downloads: smartify_os_downloads.json
 * ```
 *
 * ```json
 * {
 *   "folder": "voice_assistant/models",
 *   "items": [
 *     {
 *       "id": "whisper_base",
 *       "title": "Whisper base",
 *       "about": "Understands what is said, in nearly every language",
 *       "folder": "whisper-base",
 *       "sizeMb": 160,
 *       "default": ["arm64"],
 *       "setting": "recognizer",
 *       "value": "SpeechModels.whisperBase",
 *       "files": [
 *         { "url": "https://example.com/base-encoder.onnx", "path": "base-encoder.onnx" },
 *         { "huggingFace": "csukuangfj/kokoro-multi-lang-v1_0", "folder": "espeak-ng-data" },
 *         { "archive": "https://example.com/model.tar.bz2", "keep": { "model/a.onnx": "a.onnx" } }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * Every item is a folder of its own in `~/.local/share/smartify-os/<folder>/` on the car (on
 * Linux), which only exists once it is complete: whatever puts it there, the package itself or
 * the CLI, fills `<item folder>.part` and renames it. A folder that is there is never touched.
 *
 * Which items go on the car unless the owner says otherwise:
 *
 * - `required`: always, without asking.
 * - `setting` and `value`: the item is what one of the extension's settings can be, written
 *   as `value` in lib/main.dart. When the app sets that setting, the items it names go on the
 *   car, and for a setting that holds one (not a list or a map) the others of it do not.
 * - `default`: otherwise, `true` or the architectures it is picked on (a lighter one on a
 *   Raspberry Pi).
 *
 * A JSON file rather than YAML in the pubspec, since a package usually writes it from the code
 * that downloads the same things, which keeps the two in step. Nothing in here throws: a broken
 * item is left out and reported.
 */

/** One piece of an item, downloaded into its folder. */
export type DownloadPart =
	/** A single file, saved at `path` in the folder. */
	| { kind: 'file'; url: string; path: string }
	/** Every file in `folder` of a Hugging Face repository, kept at the same path. */
	| { kind: 'huggingFace'; repo: string; folder: string; revision: string }
	/** A tar archive (any compression), of which only `keep` is kept: its path in there, and where it goes. */
	| { kind: 'archive'; url: string; keep: Record<string, string> };

/** One thing a package downloads, a folder of its own. */
export interface DownloadItem {
	/** Unique in its package. */
	id: string;
	title: string;
	about: string | undefined;
	/** Its folder's name, inside the package's folder. */
	folder: string;
	/** Roughly how big it is, in megabytes. */
	sizeMb: number;
	required: boolean;
	/** On which architectures it is picked without a setting saying otherwise, null for none. */
	default: LinuxArch[] | null;
	/** The extension's setting it is one of the values of, and how lib/main.dart writes it. */
	setting: { name: string; value: string } | undefined;
	parts: DownloadPart[];
}

/** Everything one package downloads. */
export interface DownloadList {
	requester: Requester;
	/** Where it all goes, relative to `smartify-os` in the car's data folder: `voice_assistant/models`. */
	folder: string;
	items: DownloadItem[];
}

/** A plain name: a folder or an id, never a path. */
const plainName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const idName = /^[a-z0-9][a-z0-9_]*$/;

/** The name a package's folders start with: its name without `smartify_os_`. */
export function packageId(packageName: string): string {
	return packageName.replace(/^smartify_os_/, '');
}

/**
 * The file a package's `smartify_os: downloads:` names, read and checked. Undefined when it
 * names none.
 */
export async function readDownloads(
	root: string,
	requester: Requester,
	section: unknown,
): Promise<{ list: DownloadList | undefined; problems: ListProblem[] }> {
	const problems: ListProblem[] = [];
	const problem: Report = (kind, path, message) => problems.push({ kind, path, message });
	const map = asMap(section, 'smartify_os', problem);
	const named = map?.downloads;
	if (named === undefined || named === null) return { list: undefined, problems };

	const path = 'smartify_os.downloads';
	if (typeof named !== 'string' || !isInside(named)) {
		problem(
			'invalid',
			path,
			`${path} has to name a JSON file in the package, like smartify_os_downloads.json.`,
		);
		return { list: undefined, problems };
	}
	let json: unknown;
	try {
		json = await Bun.file(join(root, named)).json();
	} catch (error) {
		const missing = !(await Bun.file(join(root, named)).exists());
		problem(
			'invalid',
			path,
			missing
				? `${named} is not in the package.`
				: `${named} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { list: undefined, problems };
	}
	const list = parseDownloads(json, requester, named, problem);
	return { list, problems };
}

/** Reads a downloads file. `file` is its name, for saying where a problem is. */
export function parseDownloads(
	json: unknown,
	requester: Requester,
	file: string,
	problem: Report,
): DownloadList | undefined {
	const root = asMap(json, file, problem);
	if (!root) return undefined;
	unknownKeys(root, ['folder', 'items'], file, problem);

	const own = packageId(requester.name);
	const folder = typeof root.folder === 'string' ? root.folder.replace(/\/+$/, '') : '';
	const segments = folder.split('/');
	if (!folder || !segments.every((s) => plainName.test(s)) || segments[0] !== own) {
		problem(
			'invalid',
			`${file}.folder`,
			`folder has to be a folder of the package's own, starting with ${own}/, like ${own}/models.`,
		);
		return undefined;
	}
	if (!Array.isArray(root.items)) {
		problem('invalid', `${file}.items`, 'items has to be a list.');
		return undefined;
	}

	const items: DownloadItem[] = [];
	root.items.forEach((value, index) => {
		const item = parseItem(value, `${file}.items[${index}]`, problem);
		if (!item) return;
		if (items.some((other) => other.id === item.id)) {
			problem('invalid', `${file}.items[${index}].id`, `Two items are called ${item.id}.`);
			return;
		}
		items.push(item);
	});
	return { requester, folder, items };
}

function parseItem(value: unknown, path: string, problem: Report): DownloadItem | undefined {
	const map = asMap(value, path, problem);
	if (!map) return undefined;
	unknownKeys(
		map,
		[
			'id',
			'title',
			'about',
			'folder',
			'sizeMb',
			'required',
			'default',
			'setting',
			'value',
			'files',
		],
		path,
		problem,
	);
	const bad = (key: string, message: string) => {
		problem('invalid', `${path}.${key}`, message);
		return undefined;
	};

	if (typeof map.id !== 'string' || !idName.test(map.id)) {
		return bad('id', 'id has to be a name of lowercase letters, numbers and _, like whisper_base.');
	}
	if (typeof map.title !== 'string' || !map.title.trim())
		return bad('title', 'title has to be text.');
	if (map.about !== undefined && typeof map.about !== 'string')
		return bad('about', 'about has to be text.');
	if (
		typeof map.folder !== 'string' ||
		!plainName.test(map.folder) ||
		map.folder.endsWith('.part')
	) {
		return bad('folder', 'folder has to be a plain folder name, like whisper-base.');
	}
	if (typeof map.sizeMb !== 'number' || !(map.sizeMb >= 0)) {
		return bad('sizeMb', 'sizeMb has to be how many megabytes it is, roughly.');
	}
	if (map.required !== undefined && typeof map.required !== 'boolean') {
		return bad('required', 'required is true or false.');
	}

	let picked: LinuxArch[] | null = null;
	if (map.default === true) picked = [...linuxArchs];
	else if (Array.isArray(map.default)) {
		const wrong = map.default.filter((a) => !linuxArchs.includes(a as LinuxArch));
		if (wrong.length > 0)
			return bad('default', `default can only name ${linuxArchs.join(' and ')}.`);
		picked = [...new Set(map.default as LinuxArch[])];
	} else if (map.default !== undefined && map.default !== false) {
		return bad(
			'default',
			'default is true, false, or the architectures it is picked on, like ["x64"].',
		);
	}

	let setting: DownloadItem['setting'];
	if (map.setting !== undefined || map.value !== undefined) {
		if (typeof map.setting !== 'string' || !/^[A-Za-z_]\w*$/.test(map.setting)) {
			return bad('setting', "setting has to be the name of one of the extension's settings.");
		}
		if (typeof map.value !== 'string' || !map.value.trim()) {
			return bad(
				'value',
				'value has to be how lib/main.dart writes it, like SpeechModels.whisperBase.',
			);
		}
		setting = { name: map.setting, value: map.value.trim() };
	}

	if (!Array.isArray(map.files) || map.files.length === 0)
		return bad('files', 'files has to list what to download.');
	const parts: DownloadPart[] = [];
	for (const [index, part] of map.files.entries()) {
		const read = parsePart(part, `${path}.files[${index}]`, problem);
		if (!read) return undefined;
		parts.push(read);
	}

	return {
		id: map.id,
		title: map.title.trim(),
		about: typeof map.about === 'string' && map.about.trim() ? map.about.trim() : undefined,
		folder: map.folder,
		sizeMb: map.sizeMb,
		required: map.required === true,
		default: picked,
		setting,
		parts,
	};
}

function parsePart(value: unknown, path: string, problem: Report): DownloadPart | undefined {
	const map = asMap(value, path, problem);
	if (!map) return undefined;
	const bad = (message: string) => {
		problem('invalid', path, message);
		return undefined;
	};

	if ('url' in map) {
		unknownKeys(map, ['url', 'path'], path, problem);
		if (!isWebAddress(map.url)) return bad('url has to be an https:// address.');
		if (typeof map.path !== 'string' || !isInside(map.path))
			return bad('path has to be a path inside the folder.');
		return { kind: 'file', url: map.url, path: map.path };
	}
	if ('huggingFace' in map) {
		unknownKeys(map, ['huggingFace', 'folder', 'revision'], path, problem);
		if (typeof map.huggingFace !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(map.huggingFace)) {
			return bad('huggingFace has to be a repository, like csukuangfj/kokoro-multi-lang-v1_0.');
		}
		if (typeof map.folder !== 'string' || !isInside(map.folder))
			return bad('folder has to be a folder of the repository.');
		if (
			map.revision !== undefined &&
			(typeof map.revision !== 'string' || !/^[\w.-]+$/.test(map.revision))
		) {
			return bad('revision has to be a branch, tag or commit.');
		}
		return {
			kind: 'huggingFace',
			repo: map.huggingFace,
			folder: map.folder.replace(/\/+$/, ''),
			revision: typeof map.revision === 'string' ? map.revision : 'main',
		};
	}
	if ('archive' in map) {
		unknownKeys(map, ['archive', 'keep'], path, problem);
		if (!isWebAddress(map.archive)) return bad('archive has to be an https:// address.');
		const keep = asMap(map.keep, `${path}.keep`, problem);
		const entries = Object.entries(keep ?? {});
		if (
			entries.length === 0 ||
			!entries.every(([from, to]) => isInside(from) && typeof to === 'string' && isInside(to))
		) {
			return bad('keep has to map paths in the archive to paths inside the folder.');
		}
		return {
			kind: 'archive',
			url: map.archive,
			keep: Object.fromEntries(entries) as Record<string, string>,
		};
	}
	return bad(
		'Each of files is a file (url and path), a Hugging Face folder (huggingFace and folder), or an archive (archive and keep).',
	);
}

/** Internal: a relative path that stays inside where it is. */
function isInside(path: unknown): path is string {
	if (typeof path !== 'string' || !path.trim()) return false;
	if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false;
	return path.split('/').every((part) => part !== '..' && part !== '.' && part !== '');
}

function isWebAddress(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

/** One item of one package, with whether it goes on the car unless the owner says otherwise. */
export interface DownloadChoice {
	list: DownloadList;
	item: DownloadItem;
	/** `voice_assistant.whisper_base`, what `--download` takes. */
	key: string;
	picked: boolean;
	/** Why it is picked, or why not, for a hint. */
	reason: 'required' | 'setting' | 'replaced' | 'default' | 'not-default';
}

/**
 * What lib/main.dart gives one extension's settings, as code: the constant or the list or map
 * written for each, by name. A setting that is not written is left out.
 */
export interface WrittenSettings {
	code: Record<string, string>;
	/** The settings that hold several (a list or a map), by name. */
	collections: Set<string>;
}

/**
 * Which items go on the car unless the owner says otherwise, see the rules at the top.
 * `arch` is the car's, undefined while it is not known, which only `default` cares about.
 */
export function chooseDownloads(
	lists: DownloadList[],
	settings: Map<string, WrittenSettings>,
	arch: LinuxArch | undefined,
): DownloadChoice[] {
	const choices: DownloadChoice[] = [];
	for (const list of lists) {
		const written = settings.get(list.requester.name);
		for (const item of list.items) {
			const key = `${packageId(list.requester.name)}.${item.id}`;
			let reason: DownloadChoice['reason'];
			const code = item.setting && written?.code[item.setting.name];
			if (item.required) reason = 'required';
			else if (item.setting && code !== undefined && names(code, item.setting.value))
				reason = 'setting';
			else if (item.setting && code !== undefined && !written?.collections.has(item.setting.name)) {
				reason = 'replaced';
			} else if (
				item.default &&
				(arch === undefined ? item.default.length > 0 : item.default.includes(arch))
			) {
				reason = 'default';
			} else reason = 'not-default';
			choices.push({
				list,
				item,
				key,
				picked: reason === 'required' || reason === 'setting' || reason === 'default',
				reason,
			});
		}
	}
	return choices;
}

/** Whether downloads pick differently by architecture, so it is worth knowing the car's. */
export function dependsOnArch(lists: DownloadList[]): boolean {
	return lists.some((list) =>
		list.items.some(
			(item) => item.default && item.default.length > 0 && item.default.length < linuxArchs.length,
		),
	);
}

/** Internal: whether code names a value as a whole, `SpeechModels.whisperBase` but not `...whisperBaseEn`. */
function names(code: string, value: string): boolean {
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(?<![\\w.$])${escaped}(?![\\w$])`).test(code);
}

/** Where an item goes, relative to the `smartify-os` data folder: `voice_assistant/models/whisper-base`. */
export function itemPath(list: DownloadList, item: DownloadItem): string {
	return `${list.folder}/${item.folder}`;
}
