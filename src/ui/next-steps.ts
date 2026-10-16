import { emit, isJsonMode } from './json.ts';
import { note } from './prompt.ts';

/**
 * What the user does next, after a command: "write its program", "put it on its board".
 *
 * A terminal shows `text`, which names the commands to type. A GUI has buttons for those
 * instead, so with `--json` every step goes along as data too, and `kind` lets the GUI say it
 * in its own words. A GUI that does not know a kind shows `text`.
 */
export interface NextStep {
	/** What the step is, the same for as long as the step means the same, like `run`. */
	kind: string;
	/** The step in words for the terminal. */
	text: string;
	/**
	 * The file or folder it is about: inside the project relative to it, with forward slashes,
	 * or absolute for a folder of its own (the project just made, say).
	 */
	path?: string;
}

/** Shows the next steps in a note, numbered unless `numbered` is false. */
export function nextSteps(
	steps: NextStep[],
	{ title = 'Next', numbered = true }: { title?: string; numbered?: boolean } = {},
): void {
	const text = steps
		.map((step, index) => (numbered ? `${index + 1}. ${step.text}` : step.text))
		.join('\n');
	if (isJsonMode()) emit({ type: 'log', level: 'note', title, text, data: { steps } });
	else note(text, title);
}
