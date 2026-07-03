// Canvas QR renderer for the Receive panel. CSP note: the manifest's img-src 'self' forbids
// data:/blob: images, so the code is DRAWN onto a canvas, never set as an <img> source.
// Dark modules on a light card for scanner reliability; ECC level M; 4-module quiet zone;
// integer module scale (DPR-aware) so modules stay crisp. Pure rendering: no keys, no network.
import qrcodegen from "./qrcodegen.js";

export function drawQr(canvas: HTMLCanvasElement, text: string): void {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const quiet = 4;                                   // spec-required light border, drawn inside the canvas
  const modules = qr.size + quiet * 2;
  const dpr = Math.max(1, Math.min(3, Math.round((globalThis.devicePixelRatio as number) || 1)));
  const scale = Math.max(2, Math.floor((190 * dpr) / modules));
  const px = modules * scale;
  canvas.width = px; canvas.height = px;
  canvas.style.width = canvas.style.height = `${px / dpr}px`;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#f2f2f2"; g.fillRect(0, 0, px, px);
  g.fillStyle = "#0a0a0a";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
}
