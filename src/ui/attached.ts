import { runInTerminal, runStreaming, type Tool } from '../core/process.ts';
import { emit, forwardInput, isJsonMode } from './json.ts';

/**
 * Running a tool the user talks to while it runs, like `flutter run`: in the user's own
 * terminal, keys and colors included, or for a program reading `--json` with what it prints
 * as `output` events and `{"input": "r"}` on stdin typed into it.
 *
 * @returns its exit code.
 */
export async function runAttached(
	tool: Tool,
	args: string[],
	cwd: string,
	options: { stopsWithCtrlC?: boolean; env?: Record<string, string> } = {},
): Promise<number> {
	if (isJsonMode()) {
		const child = runStreaming(
			tool,
			args,
			cwd,
			(stream, text) => emit({ type: 'output', stream, text }),
			options.env,
		);
		const stop = forwardInput((text) => child.write(text));
		try {
			return await child.exited;
		} finally {
			stop();
		}
	}

	// Ctrl+C reaches the CLI as well as the tool, and would end it halfway through saying
	// goodbye. For a tool that is stopped that way, the CLI lets the tool take it alone.
	const ignore = () => {};
	if (options.stopsWithCtrlC) process.on('SIGINT', ignore);
	try {
		return await runInTerminal(tool, args, cwd, options.env);
	} finally {
		if (options.stopsWithCtrlC) process.off('SIGINT', ignore);
	}
}
