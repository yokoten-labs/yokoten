// Text that is anyone's, shown on a terminal: control and bidi characters never go out raw.

export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
/** A character as a `\uXXXX` escape, which TypeScript reads back and a terminal shows as text. */
export const unicodeEscape = (character: string) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
/**
 * Text that is safe to print: each control character but tab and newline (so ESC, CR, DEL
 * and C1, which start ANSI and OSC codes) and each bidi control is shown as `\uXXXX`.
 */
export const terminalText = (text: string) => text.replace(CONTROL, unicodeEscape).replace(BIDI, unicodeEscape);
/** A value someone typed or set, for a message: a plain word as typed, any other quoted with its odd characters escaped. */
export const shownValue = (value: string): string => (/^[\w./-]*$/.test(value) ? value : terminalText(JSON.stringify(value)));
