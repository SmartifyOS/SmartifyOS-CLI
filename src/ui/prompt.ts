import type {
	ConfirmOptions,
	MultiSelectOptions,
	PasswordOptions,
	SelectOptions,
	TextOptions,
} from '@clack/prompts';
import * as clack from '@clack/prompts';
import { CancelledError, CliError } from '../utils/errors.ts';
import { ask, emit, isJsonMode, type PromptOption, stepId } from './json.ts';

/**
 * Every prompt in the CLI goes through this file.
 *
 * Two things happen here that would otherwise be repeated in every command. Ctrl+C turns
 * into a {@link CancelledError} instead of a symbol you have to remember to check, and a
 * prompt asked when nobody can answer it (piped output, CI, `--yes`) fails with a clear
 * message rather than hanging forever.
 */

/**
 * Internal: turns clack's cancel symbol into a thrown {@link CancelledError}.
 */
function unwrap<T>(value: T | symbol): T {
	if (clack.isCancel(value)) {
		throw new CancelledError();
	}
	return value as T;
}

/**
 * Whether the user can actually answer a prompt right now.
 *
 * False when output is piped somewhere, when running in CI, or when the user passed
 * `--yes`. Commands should use this to decide between asking and using a default.
 *
 * Always true with `--json`, where the program running the CLI answers on stdin.
 */
export function isInteractive(): boolean {
	return isJsonMode() || (clack.isTTY(process.stdout) && !clack.isCI());
}

/**
 * Internal: called before every prompt so a non interactive run fails loudly and early
 * instead of hanging on a question nobody will see.
 */
function assertInteractive(message: string): void {
	if (isInteractive()) return;
	throw new CliError(`Needed to ask "${message}" but there is nobody to answer.`, {
		hint: 'Pass the answer as a flag, or run this in a normal terminal.',
	});
}

/** Ask for a line of text. */
export async function text(opts: TextOptions): Promise<string> {
	if (isJsonMode()) return await askText('text', opts);
	assertInteractive(opts.message);
	return unwrap(await clack.text(opts));
}

/** Ask for a line of text, masked while typing. */
export async function password(opts: PasswordOptions): Promise<string> {
	if (isJsonMode()) return await askText('password', opts);
	assertInteractive(opts.message);
	return unwrap(await clack.password(opts));
}

/** Ask a yes or no question. */
export async function confirm(opts: ConfirmOptions): Promise<boolean> {
	if (isJsonMode()) {
		const prompt = {
			kind: 'confirm' as const,
			message: opts.message,
			initialValue: opts.initialValue,
		};
		return (await ask(prompt, (value) =>
			typeof value === 'boolean' ? undefined : 'The answer has to be true or false.',
		)) as boolean;
	}
	assertInteractive(opts.message);
	return unwrap(await clack.confirm(opts));
}

/** Ask the user to pick one option. */
export async function select<Value>(opts: SelectOptions<Value>): Promise<Value> {
	if (isJsonMode()) {
		const options = describeOptions(opts.options);
		const prompt = {
			kind: 'select' as const,
			message: opts.message,
			options,
			initialValue: opts.initialValue,
		};
		return (await ask(prompt, (value) =>
			isOption(options, value)
				? undefined
				: 'The answer has to be the value of one of the options.',
		)) as Value;
	}
	assertInteractive(opts.message);
	return unwrap(await clack.select(opts));
}

/** Ask the user to pick any number of options. */
export async function multiselect<Value>(opts: MultiSelectOptions<Value>): Promise<Value[]> {
	if (isJsonMode()) {
		const options = describeOptions(opts.options);
		const prompt = {
			kind: 'multiselect' as const,
			message: opts.message,
			options,
			initialValue: opts.initialValues,
		};
		return (await ask(prompt, (value) => {
			if (!Array.isArray(value) || !value.every((v) => isOption(options, v))) {
				return 'The answer has to be a list of values of the options.';
			}
			if (value.length === 0 && opts.required !== false) return 'Pick at least one.';
			return undefined;
		})) as Value[];
	}
	assertInteractive(opts.message);
	return unwrap(await clack.multiselect(opts));
}

/** Internal: a text or password question with `--json`, checked the way clack checks it. */
async function askText(
	kind: 'text' | 'password',
	opts: TextOptions | PasswordOptions,
): Promise<string> {
	const defaultValue = 'defaultValue' in opts ? opts.defaultValue : undefined;
	const prompt = {
		kind,
		message: opts.message,
		...('placeholder' in opts && opts.placeholder ? { placeholder: opts.placeholder } : {}),
		...(defaultValue ? { initialValue: defaultValue } : {}),
	};
	const value = await ask(prompt, (value) => {
		if (typeof value !== 'string') return 'The answer has to be a string.';
		// Checked after the default is filled in, just as clack does for a person.
		const problem =
			typeof opts.validate === 'function' ? opts.validate(value || defaultValue) : undefined;
		return problem instanceof Error ? problem.message : problem;
	});
	return (value as string) || defaultValue || '';
}

/** Internal: the options of a select, the way a program sees them. */
function describeOptions<Value>(options: SelectOptions<Value>['options']): PromptOption[] {
	return options.map((option) => {
		const { value, label, hint } = option as { value: unknown; label?: string; hint?: string };
		return { value, label: label ?? String(value), ...(hint ? { hint } : {}) };
	});
}

/** Internal: whether an answer is one of the options, compared as JSON is. */
function isOption(options: PromptOption[], value: unknown): boolean {
	return options.some((option) => Bun.deepEquals(option.value, value));
}

/** A spinner, or the `step` events standing in for one with `--json`. */
export interface Spinner {
	start(text?: string): void;
	message(text?: string): void;
	stop(text?: string): void;
	error(text?: string): void;
}

/** Shows that something is being worked on. */
export function spinner(): Spinner {
	if (!isJsonMode()) return clack.spinner();

	const id = stepId();
	let last = '';
	const send = (status: 'start' | 'update' | 'done' | 'error', text: string | undefined) => {
		last = text ?? last;
		emit({ type: 'step', id, status, text: last });
	};
	return {
		start: (text) => send('start', text),
		message: (text) => send('update', text),
		stop: (text) => send('done', text),
		error: (text) => send('error', text),
	};
}

/** A block of text with a title, like a changelog. */
export function note(message: string, title?: string): void {
	if (isJsonMode())
		emit({ type: 'log', level: 'note', text: message, ...(title ? { title } : {}) });
	else clack.note(message, title);
}
