import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { CancelledError, CliError } from '../utils/errors.ts';

/**
 * The machine readable side of the CLI, switched on with `--json`.
 *
 * Every line on stdout is then one JSON event, and questions are answered by writing JSON
 * lines to stdin, so a program (the GUI, or an AI agent) can do everything a person in the
 * terminal can. Commands never see any of this: the wrappers in output.ts and prompt.ts
 * branch on {@link isJsonMode}, which is what keeps the two modes from drifting apart.
 *
 * The protocol is described for its users in README.md. Change it only by adding to it,
 * and bump {@link protocolVersion} if something has to change in a way that breaks a reader.
 */

/** Goes up only when an existing event changes in a way that would break a reader. */
export const protocolVersion = 1;

export type PromptKind = 'text' | 'password' | 'confirm' | 'select' | 'multiselect';

export interface PromptOption {
	value: unknown;
	label: string;
	hint?: string;
}

/** A question, as a program sees it. */
export interface PromptEvent {
	type: 'prompt';
	id: string;
	kind: PromptKind;
	message: string;
	options?: PromptOption[];
	initialValue?: unknown;
	placeholder?: string;
}

export type LogLevel =
	| 'info'
	| 'warn'
	| 'error'
	| 'success'
	| 'message'
	| 'step'
	| 'intro'
	| 'outro'
	| 'note';

/** What went wrong, in the closing `result` event of a failed run. */
export interface ErrorPayload {
	/** `user` is something the user can fix, `bug` is a bug in the CLI. */
	kind: 'user' | 'bug' | 'cancelled';
	message: string;
	hint?: string;
	details?: unknown;
	stack?: string;
}

/** Every event the CLI writes to stdout in JSON mode. */
export type Event =
	| { type: 'start'; protocol: number; version: string; sha: string; command: string | null }
	| { type: 'log'; level: LogLevel; text: string; title?: string; data?: unknown }
	| { type: 'text'; text: string }
	| { type: 'step'; id: string; status: 'start' | 'update' | 'done' | 'error'; text: string }
	| PromptEvent
	| { type: 'prompt-invalid'; id: string; message: string }
	| { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
	| { type: 'result'; ok: true; exitCode: number; data: unknown }
	| { type: 'result'; ok: false; exitCode: number; error: ErrorPayload };

let enabled = false;

/** Switches the whole CLI to JSON events. Called once, from src/index.ts. */
export function enableJsonMode(): void {
	enabled = true;
}

export function isJsonMode(): boolean {
	return enabled;
}

/**
 * Whether argv asks for JSON mode.
 *
 * Looked for by hand rather than with `parse`, because a mistyped flag has to be reported
 * as JSON too, and `parse` is what throws on one. Nothing after `--` counts.
 */
export function wantsJson(argv: string[]): boolean {
	const end = argv.indexOf('--');
	return (end === -1 ? argv : argv.slice(0, end)).includes('--json');
}

/** Internal: where events go. Only ever swapped by a test. */
let write = (line: string): void => {
	process.stdout.write(line);
};

/** Writes one event. The only thing in JSON mode that writes to stdout. */
export function emit(event: Event): void {
	// Messages are built with theme colors for the terminal. A program wants the words.
	const line = JSON.stringify(event, (_key, value) =>
		typeof value === 'string' ? stripVTControlCharacters(value) : value,
	);
	write(`${line}\n`);
}

/** Internal: a message on stdin, answering a prompt or meant for a running child process. */
interface Message {
	id?: string;
	value?: unknown;
	cancel?: boolean;
	input?: string;
}

/** Internal: one line of stdin as a message, or undefined when it is not a JSON object. */
function parseMessage(line: string): Message | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Message;
		}
	} catch {
		// Not JSON at all, which is reported the same way as JSON that is not an object.
	}
	return undefined;
}

/**
 * Internal: reads stdin line by line and hands each message to whoever it is for.
 *
 * An answer can arrive before its question. A script can pipe all its answers in up front,
 * either with the prompt ids it expects or with no id at all, in which case each one
 * answers the next question asked.
 */
class Inbox {
	private readonly early: Message[] = [];
	private waiting: ((message: Message | undefined) => void) | undefined;
	private waitingId: string | undefined;
	private closed = false;
	private readonly close: () => void;
	/** Where `{"input": ...}` goes, while a child process is running. */
	onInput: ((text: string) => void) | undefined;

	constructor(input: Readable) {
		const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		lines.on('line', (line) => this.receive(line));
		lines.on('close', () => {
			this.closed = true;
			this.deliver(undefined);
		});
		this.close = () => lines.close();
	}

	private receive(line: string): void {
		if (!line.trim()) return;
		const message = parseMessage(line);
		if (!message) {
			emit({
				type: 'log',
				level: 'warn',
				text: `Ignored a line on stdin that is not a JSON object: ${line}`,
			});
			return;
		}

		if (typeof message.input === 'string') {
			if (this.onInput) this.onInput(message.input);
			else
				emit({ type: 'log', level: 'warn', text: 'Ignored input, nothing is running to take it.' });
			return;
		}

		if (this.waiting && (message.id === undefined || message.id === this.waitingId)) {
			this.deliver(message);
			return;
		}
		this.early.push(message);
	}

	private deliver(message: Message | undefined): void {
		const waiting = this.waiting;
		this.waiting = undefined;
		this.waitingId = undefined;
		waiting?.(message);
	}

	/** The next answer for prompt `id`, or undefined once stdin has ended. */
	next(id: string): Promise<Message | undefined> {
		const index = this.early.findIndex((m) => m.id === id || m.id === undefined);
		if (index !== -1) return Promise.resolve(this.early.splice(index, 1)[0]);
		if (this.closed) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			this.waiting = resolve;
			this.waitingId = id;
		});
	}

	shutDown(): void {
		this.close();
	}
}

let inbox: Inbox | undefined;
let input: Readable | undefined;

/**
 * Internal: made on first use, so that a run that never asks anything never touches stdin.
 */
function theInbox(): Inbox {
	inbox ??= new Inbox(input ?? process.stdin);
	return inbox;
}

/**
 * Stops reading stdin. Called once the run is over, since a program that keeps its end of
 * stdin open would otherwise keep the CLI from exiting.
 */
export function closeInput(): void {
	inbox?.shutDown();
	if (!input) process.stdin.pause();
}

/**
 * Lets a running child process take `{"input": ...}` messages from stdin.
 *
 * @returns a function that stops it again.
 */
export function forwardInput(handler: (text: string) => void): () => void {
	const box = theInbox();
	box.onInput = handler;
	return () => {
		if (box.onInput === handler) box.onInput = undefined;
	};
}

let nextPrompt = 0;
let nextStep = 0;

/** A fresh id for a `step` event, so a program can tell overlapping steps apart. */
export function stepId(): string {
	nextStep += 1;
	return `s${nextStep}`;
}

/**
 * Asks a program a question and waits for the answer.
 *
 * `check` returns why an answer is not acceptable. Such an answer gets a `prompt-invalid`
 * and the same question stays open for another try.
 *
 * @throws {CancelledError} when the program sends `{"id": ..., "cancel": true}`.
 * @throws {CliError} when stdin ends first, naming the question in `details`.
 */
export async function ask(
	prompt: Omit<PromptEvent, 'type' | 'id'>,
	check: (value: unknown) => string | undefined,
): Promise<unknown> {
	nextPrompt += 1;
	const event: PromptEvent = { type: 'prompt', id: `p${nextPrompt}`, ...prompt };
	emit(event);

	while (true) {
		const message = await theInbox().next(event.id);
		if (!message) {
			throw new CliError(`Needed to ask "${prompt.message}" but stdin has ended.`, {
				hint: `Pass the answer as a flag, or answer on stdin with a line like {"id":"${event.id}","value":...}.`,
				details: { prompt: event },
			});
		}
		if (message.cancel === true) throw new CancelledError();

		const problem = check(message.value);
		if (problem === undefined) return message.value;
		emit({ type: 'prompt-invalid', id: event.id, message: problem });
	}
}

/**
 * Internal: for tests only. Points JSON mode at other streams and forgets any state, so
 * one test cannot leak into the next.
 */
export function resetJsonForTests(options: {
	enabled: boolean;
	write?: (line: string) => void;
	input?: Readable;
}): void {
	enabled = options.enabled;
	if (options.write) write = options.write;
	inbox?.shutDown();
	inbox = undefined;
	input = options.input;
	nextPrompt = 0;
	nextStep = 0;
}
