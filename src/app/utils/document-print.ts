import { Capacitor, registerPlugin } from '@capacitor/core';
const NativePrint = registerPlugin<{ printHtml(options: { html: string; title: string }): Promise<void> }>('OfflinePrint');
export const nativeDocumentPrint = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
export function createPrintWindow(): Window | null {
  if (nativeDocumentPrint()) return null;
  const popup = window.open('', '_blank');
  if (!popup) throw new Error('Allow pop-ups to open the print preview.');
  popup.document.title = 'Preparing print preview';
  popup.document.body.textContent = 'Preparing document...';
  return popup;
}
export async function printHtmlDocument(html: string, title: string, popup: Window | null): Promise<void> {
  if (nativeDocumentPrint()) { await NativePrint.printHtml({ html, title }); return; }
  if (!popup || popup.closed) throw new Error('Print preview was closed. Please try again.');
  popup.document.open(); popup.document.write(html); popup.document.close();
  await Promise.all(Array.from(popup.document.images).map(img => img.decode()));
  await popup.document.fonts.ready;
  popup.focus(); popup.print();
}
export function escapePrintText(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
