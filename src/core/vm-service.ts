/**
 * Talking to a car's app while `run` runs it, through the Dart VM service `flutter run`
 * starts with every debug build.
 *
 * SmartifyOS registers its own service extensions in a debug build (`EditorBridge` in
 * core), `ext.smartifyOs.describe` and the like, which is how the editor changes the
 * running app without a restart. This only finds the service and calls them.
 */

/** What every SmartifyOS service extension starts with. */
export const extensionPrefix = 'ext.smartifyOs.';

/**
 * The VM service's WebSocket address, from the line `flutter run` prints once the app is up:
 *
 * ```text
 * A Dart VM Service on macOS is available at: http://127.0.0.1:61234/Hk3m2Dq0aXY=/
 * ```
 *
 * Undefined for any other line.
 */
export function vmServiceAddress(line: string): string | undefined {
	const url = /Dart VM Service .* is available at:\s*(https?:\/\/\S+)/.exec(line)?.[1];
	if (!url) return undefined;
	const withSlash = url.endsWith('/') ? url : `${url}/`;
	return `${withSlash.replace(/^http/, 'ws')}ws`;
}

/** Internal: a JSON-RPC answer from the VM service. */
interface RpcAnswer {
	id?: string;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: { details?: string } };
}

/** Why a call into the running app did not work, said for the person or program that made it. */
export class AppCallError extends Error {}

/**
 * One connection to the VM service. Opened on the first call and opened again whenever it
 * dropped, since nothing is lost by that.
 */
export class VmService {
	private socket: WebSocket | undefined;
	private opening: Promise<WebSocket> | undefined;
	private nextId = 0;
	private readonly waiting = new Map<string, (answer: RpcAnswer) => void>();

	constructor(private readonly address: string) {}

	/**
	 * Calls one of SmartifyOS's service extensions, `describe` for `ext.smartifyOs.describe`,
	 * and gives back what it answered.
	 *
	 * Each value is handed over as a string, which is all a service extension takes: a string
	 * as it is, anything else as JSON.
	 *
	 * @throws {AppCallError} when the app is not there, has no such extension (a SmartifyOS from
	 * before it), or the extension failed.
	 */
	async callExtension(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const method = `${extensionPrefix}${name}`;
		const isolateId = await this.isolateWith(method);
		const strings: Record<string, string> = {};
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined) continue;
			strings[key] = typeof value === 'string' ? value : JSON.stringify(value);
		}
		const answer = await this.request(method, { ...strings, isolateId });
		if (answer.error) {
			throw new AppCallError(answer.error.data?.details ?? answer.error.message);
		}
		// The VM service adds what kind of answer it is, which is not part of it.
		const { type: _type, method: _method, ...result } = answer.result ?? {};
		return result;
	}

	/** Closes the connection. */
	close(): void {
		this.socket?.close();
		this.socket = undefined;
		this.opening = undefined;
	}

	/**
	 * Internal: the isolate that has the extension, looked up every time, since a hot
	 * restart starts the app in a new one.
	 */
	private async isolateWith(method: string): Promise<string> {
		const vm = await this.request('getVM', {});
		const isolates = (vm.result?.isolates ?? []) as { id: string }[];
		let running = false;
		for (const { id } of isolates) {
			const isolate = await this.request('getIsolate', { isolateId: id });
			if (!isolate.result) continue;
			running = true;
			const extensions = (isolate.result.extensionRPCs ?? []) as string[];
			if (extensions.includes(method)) return id;
		}
		throw new AppCallError(
			running
				? `Your car's app does not know ${method} yet. It needs a newer SmartifyOS.`
				: "Your car's app is not running yet.",
		);
	}

	/** Internal: one JSON-RPC request, and its answer. */
	private async request(method: string, params: Record<string, unknown>): Promise<RpcAnswer> {
		const socket = await this.open();
		this.nextId += 1;
		const id = String(this.nextId);
		return await new Promise((resolve) => {
			this.waiting.set(id, resolve);
			socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		});
	}

	private open(): Promise<WebSocket> {
		if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
		this.opening ??= new Promise<WebSocket>((resolve, reject) => {
			const socket = new WebSocket(this.address);
			socket.addEventListener('open', () => {
				this.socket = socket;
				this.opening = undefined;
				resolve(socket);
			});
			socket.addEventListener('message', (event) => this.receive(String(event.data)));
			const gone = () => {
				if (this.socket === socket) this.socket = undefined;
				this.opening = undefined;
				for (const [id, resolveAnswer] of this.waiting) {
					resolveAnswer({ id, error: { code: -1, message: "Your car's app is not running." } });
				}
				this.waiting.clear();
				reject(new AppCallError("Your car's app is not running."));
			};
			socket.addEventListener('close', gone);
			socket.addEventListener('error', gone);
		});
		return this.opening;
	}

	private receive(text: string): void {
		let answer: RpcAnswer;
		try {
			answer = JSON.parse(text) as RpcAnswer;
		} catch {
			return;
		}
		if (answer.id === undefined) return;
		const resolve = this.waiting.get(answer.id);
		this.waiting.delete(answer.id);
		resolve?.(answer);
	}
}
