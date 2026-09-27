import { prepareScanImage } from './prepare-scan-image';

async function pngFile(canvas: HTMLCanvasElement): Promise<File> {
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
  return new File([blob], 'sheet.png', { type: 'image/png' });
}

describe('Upload image preparation', () => {
  it('keeps transparent paper white and preserves black and faint pencil marks losslessly', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#000';
    context.fillRect(0, 0, 8, 8);
    context.fillStyle = '#aaa';
    context.fillRect(8, 0, 8, 8);
    const file = await prepareScanImage(await pngFile(canvas));
    expect(file.type).toBe('image/png');
    expect(file.name).toBe('sheet.png');
    const bitmap = await createImageBitmap(file);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    expect(Array.from(context.getImageData(20, 20, 1, 1).data)).toEqual([255, 255, 255, 255]);
    expect(Array.from(context.getImageData(2, 2, 1, 1).data)).toEqual([0, 0, 0, 255]);
    expect(Array.from(context.getImageData(10, 2, 1, 1).data)).toEqual([170, 170, 170, 255]);
  });

  it('bounds square images as well as portrait and landscape images', async () => {
    for (const [width, height] of [[96, 96], [96, 48], [48, 96]]) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const bitmap = await createImageBitmap(await prepareScanImage(await pngFile(canvas), 32));
      expect(Math.max(bitmap.width, bitmap.height)).toBe(32);
      expect(bitmap.width / bitmap.height).toBe(width / height);
      bitmap.close();
    }
  });

  it('rejects corrupt images instead of sending them to detection', async () => {
    await expectAsync(prepareScanImage(new File(['invalid'], 'sheet.png', { type: 'image/png' }))).toBeRejected();
  });
});
