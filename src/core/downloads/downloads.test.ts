import { describe, expect, test } from 'bun:test';
import type { ListProblem } from '../linux/lists.ts';
import { chooseDownloads, type DownloadList, dependsOnArch, parseDownloads } from './list.ts';

const voice = { name: 'smartify_os_voice_assistant', title: 'Voice assistant' };

function parse(json: unknown): { list: DownloadList | undefined; problems: ListProblem[] } {
	const problems: ListProblem[] = [];
	const list = parseDownloads(json, voice, 'downloads.json', (kind, path, message) =>
		problems.push({ kind, path, message }),
	);
	return { list, problems };
}

const file = (name: string) => ({ url: `https://example.com/${name}`, path: name });
const item = (id: string, more: Record<string, unknown> = {}) => ({
	id,
	title: id,
	folder: id.replace(/_/g, '-'),
	sizeMb: 10,
	files: [file(`${id}.onnx`)],
	...more,
});

const catalog = {
	folder: 'voice_assistant/models',
	items: [
		item('voice_detection', { required: true }),
		item('parakeet', { default: ['x64'], setting: 'recognizer', value: 'SpeechModels.parakeet' }),
		item('whisper_base', {
			default: ['arm64'],
			setting: 'recognizer',
			value: 'SpeechModels.whisperBase',
		}),
		item('moonshine_base', { setting: 'recognizer', value: 'SpeechModels.moonshineBase' }),
		item('kokoro', { default: ['x64'], setting: 'voices', value: 'SpeechModels.kokoroFable' }),
		item('thorsten', { setting: 'voices', value: 'SpeechModels.piperThorsten' }),
	],
};

describe('parseDownloads', () => {
	test('reads every kind of part', () => {
		const { list, problems } = parse({
			folder: 'voice_assistant/models',
			items: [
				item('kokoro', {
					files: [
						file('model.onnx'),
						{ huggingFace: 'csukuangfj/kokoro-multi-lang-v1_0', folder: 'espeak-ng-data' },
						{
							archive: 'https://example.com/kws.tar.bz2',
							keep: { 'kws/tokens.txt': 'tokens.txt' },
						},
					],
				}),
			],
		});
		expect(problems).toEqual([]);
		expect(list?.items[0]?.parts).toEqual([
			{ kind: 'file', url: 'https://example.com/model.onnx', path: 'model.onnx' },
			{
				kind: 'huggingFace',
				repo: 'csukuangfj/kokoro-multi-lang-v1_0',
				folder: 'espeak-ng-data',
				revision: 'main',
			},
			{
				kind: 'archive',
				url: 'https://example.com/kws.tar.bz2',
				keep: { 'kws/tokens.txt': 'tokens.txt' },
			},
		]);
	});

	test('keeps a package to a folder of its own', () => {
		const { list, problems } = parse({ folder: 'android_auto/models', items: [] });
		expect(list).toBeUndefined();
		expect(problems[0]?.message).toContain('starting with voice_assistant/');
	});

	test('leaves out an item with a mistake, and says where', () => {
		const { list, problems } = parse({
			folder: 'voice_assistant/models',
			items: [
				item('ok'),
				item('outside', { files: [{ url: 'https://example.com/x', path: '../../.bashrc' }] }),
				item('plain_http', { files: [{ url: 'http://example.com/x', path: 'x' }] }),
				item('ok'),
			],
		});
		expect(list?.items.map((i) => i.id)).toEqual(['ok']);
		expect(problems.map((p) => p.path)).toEqual([
			'downloads.json.items[1].files[0]',
			'downloads.json.items[2].files[0]',
			'downloads.json.items[3].id',
		]);
	});
});

describe('chooseDownloads', () => {
	const list = parse(catalog).list as DownloadList;
	const picked = (choices: ReturnType<typeof chooseDownloads>) =>
		choices.filter((c) => c.picked).map((c) => c.item.id);

	test('picks what is required, and the defaults for the car', () => {
		expect(picked(chooseDownloads([list], new Map(), 'x64'))).toEqual([
			'voice_detection',
			'parakeet',
			'kokoro',
		]);
		expect(picked(chooseDownloads([list], new Map(), 'arm64'))).toEqual([
			'voice_detection',
			'whisper_base',
		]);
		expect(dependsOnArch([list])).toBe(true);
	});

	test('a setting the app writes picks what it names, in place of the defaults for one', () => {
		const settings = new Map([
			[
				voice.name,
				{
					code: {
						recognizer: 'SpeechModels.moonshineBase',
						voices: "{'de': SpeechModels.piperThorsten}",
					},
					collections: new Set(['voices']),
				},
			],
		]);
		const choices = chooseDownloads([list], settings, 'x64');
		expect(picked(choices)).toEqual(['voice_detection', 'moonshine_base', 'kokoro', 'thorsten']);
		expect(choices.find((c) => c.item.id === 'parakeet')?.reason).toBe('replaced');
		expect(choices[0]?.key).toBe('voice_assistant.voice_detection');
	});
});
