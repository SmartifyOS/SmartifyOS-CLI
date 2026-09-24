import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { CancelledError, CliError } from '../utils/errors.ts';
import { type Event, emit, resetJsonForTests, wantsJson } from './json.ts';
import { confirm, multiselect, select, spinner, text } from './prompt.ts';

/** Internal: JSON mode pointed at a fake stdin, with every event it writes collected. */
function fake(): { events: Event[]; answer(message: unknown): void; end(): void } {
	const events: Event[] = [];
	const input = new PassThrough();
	resetJsonForTests({
		enabled: true,
		input,
		write: (line) => events.push(JSON.parse(line)),
	});
	return {
		events,
		answer: (message) => input.write(`${JSON.stringify(message)}\n`),
		end: () => input.end(),
	};
}

/** Internal: lets the fake stdin deliver what was written to it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
	resetJsonForTests({ enabled: false, write: (line) => process.stdout.write(line) });
});

describe('wantsJson', () => {
	test('finds --json anywhere before --', () => {
		expect(wantsJson(['--json'])).toBe(true);
		expect(wantsJson(['extension', 'add', 'x', '--json'])).toBe(true);
		expect(wantsJson(['extension', 'list'])).toBe(false);
		expect(wantsJson(['run', '--', '--json'])).toBe(false);
	});
});

describe('emit', () => {
	test('writes one line of JSON with the colors taken out', () => {
		const lines: string[] = [];
		resetJsonForTests({ enabled: true, write: (line) => lines.push(line) });
		emit({ type: 'text', text: '\u001b[36mcyan\u001b[39m' });
		expect(lines).toEqual(['{"type":"text","text":"cyan"}\n']);
	});
});

describe('prompts with --json', () => {
	test('a question is an event and the answer comes from stdin', async () => {
		const io = fake();
		const answer = confirm({ message: 'Go?', initialValue: true });
		await tick();
		expect(io.events).toEqual([
			{ type: 'prompt', id: 'p1', kind: 'confirm', message: 'Go?', initialValue: true },
		]);
		io.answer({ id: 'p1', value: false });
		expect(await answer).toBe(false);
	});

	test('answers can be piped in before the questions, with no id', async () => {
		const io = fake();
		io.answer({ value: 'first' });
		io.answer({ value: true });
		await tick();
		expect(await text({ message: 'Name?' })).toBe('first');
		expect(await confirm({ message: 'Sure?' })).toBe(true);
	});

	test('an answer that fails the check is refused and the question stays open', async () => {
		const io = fake();
		const answer = text({
			message: 'Name?',
			validate: (value) => (value?.trim() ? undefined : 'A name is needed.'),
		});
		io.answer({ id: 'p1', value: '  ' });
		await tick();
		expect(io.events.at(-1)).toEqual({
			type: 'prompt-invalid',
			id: 'p1',
			message: 'A name is needed.',
		});
		io.answer({ id: 'p1', value: 'Dashcam' });
		expect(await answer).toBe('Dashcam');
	});

	test('a text question falls back to its default on an empty answer', async () => {
		const io = fake();
		io.answer({ value: '' });
		expect(await text({ message: 'Where?', defaultValue: '.' })).toBe('.');
	});

	test('select only takes the value of one of its options', async () => {
		const io = fake();
		const answer = select({
			message: 'Which?',
			options: [
				{ value: 'a', label: 'A' },
				{ value: 'b', label: 'B', hint: 'second' },
			],
		});
		await tick();
		expect(io.events[0]).toMatchObject({
			kind: 'select',
			options: [
				{ value: 'a', label: 'A' },
				{ value: 'b', label: 'B', hint: 'second' },
			],
		});
		io.answer({ id: 'p1', value: 'c' });
		io.answer({ id: 'p1', value: 'b' });
		expect(await answer).toBe('b');
		expect(io.events.filter((e) => e.type === 'prompt-invalid')).toHaveLength(1);
	});

	test('multiselect takes a list of option values', async () => {
		const io = fake();
		io.answer({ value: ['x', 'y'] });
		const picked = await multiselect({
			message: 'Which ones?',
			options: [{ value: 'x' }, { value: 'y' }, { value: 'z' }],
		});
		expect(picked).toEqual(['x', 'y']);
	});

	test('cancel is the same as Ctrl+C', async () => {
		const io = fake();
		io.answer({ id: 'p1', cancel: true });
		await expect(confirm({ message: 'Go?' })).rejects.toBeInstanceOf(CancelledError);
	});

	test('stdin ending before an answer fails with the question in details', async () => {
		const io = fake();
		io.end();
		const error = await confirm({ message: 'Go?' }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).details).toEqual({
			prompt: { type: 'prompt', id: 'p1', kind: 'confirm', message: 'Go?' },
		});
	});
});

describe('spinner with --json', () => {
	test('is a step that keeps its id and its last text', () => {
		const io = fake();
		const progress = spinner();
		progress.start('Fetching');
		progress.message('Checking');
		progress.stop();
		expect(io.events).toEqual([
			{ type: 'step', id: 's1', status: 'start', text: 'Fetching' },
			{ type: 'step', id: 's1', status: 'update', text: 'Checking' },
			{ type: 'step', id: 's1', status: 'done', text: 'Checking' },
		]);
	});
});
