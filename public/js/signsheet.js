// What goes on a help sign, kept apart from the screen so it can be tested on its own: the QR code's dark squares (the
// app's own QR library) and the sign's words. Plain words, very large, black on white, no small print.
import qrcode from '../vendor/qrcode/qrcode.js';

export const SIZES = {
  sticker: { label: 'Trail-sign sticker, 4 by 4 inches', short: 'Sticker 4 x 4 in' },
  tower: { label: 'Tower sign, 8.5 by 11 inches', short: 'Tower sign 8.5 x 11 in' },
};

/** The QR code for a link: { n, dark(r, c) } at error level H, so a scratched or iced sign still reads. */
export function qrMatrix(text, level = 'H') {
  const q = qrcode(0, level);
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount();
  return { n, dark: (r, c) => q.isDark(r, c) };
}

/** An SVG path for the matrix, with a quiet zone of 4 squares (what phone cameras need). */
export function qrPath(m, quiet = 4) {
  const parts = [];
  for (let r = 0; r < m.n; r++) for (let c = 0; c < m.n; c++) if (m.dark(r, c)) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
  return { d: parts.join(''), size: m.n + quiet * 2 };
}

/** +16105550100 as 610-555-0100 (as the guest page and the first reply to a text write it); other numbers as given. */
export const signNumber = (p) => { const m = String(p || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `${m[1]}-${m[2]}-${m[3]}` : String(p || ''); };

/**
 * The sign's lines, in order. number: the number guests text (the shared Verdynt/OS number or the mountain's own), or
 * null (then the text line is left out). tag: the mountain's tag. The code is printed with it ("BR R7"), so a text to the
 * shared number reaches this mountain; on the mountain's own number the tagged code works too.
 */
export function signWords({ code, mountain, number, tag }) {
  const shown = tag ? `${tag} ${code}` : String(code);
  return {
    ask: 'Need ski patrol?',
    how: number ? `Scan, or text HELP ${shown} to ${signNumber(number)}` : 'Scan this code',
    code: shown,
    emergency: 'Emergency? Call 911',
    mountain: String(mountain || ''),
  };
}
