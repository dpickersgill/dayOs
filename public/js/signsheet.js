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

/** The sign's lines, in order. number: the mountain's help number for texts, or null (then the text line is left out). */
export function signWords({ code, mountain, number }) {
  return {
    ask: 'Need ski patrol?',
    how: number ? `Scan, or text HELP ${code} to ${number}` : 'Scan this code',
    code: String(code),
    emergency: 'Emergency? Call 911',
    mountain: String(mountain || ''),
  };
}
