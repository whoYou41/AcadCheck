/** Normalize uploads once, preserving PNG marks and compositing transparency on paper white. */
export function prepareScanImage(file: File, maxDimension = 2560): Promise<File> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const sourceUrl = URL.createObjectURL(file);
    const fail = () => reject(new Error('Could not decode the selected image.'));
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      fail();
    };
    image.onload = () => {
      try {
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        // Camera JPEGs already within the limit need no second lossy encoding.
        if (scale === 1 && ['image/jpeg', 'image/jpg'].includes(file.type)) {
          resolve(file);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not prepare the selected image.');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob(blob => {
          if (!blob) { fail(); return; }
          const extension = blob.type === 'image/png' ? '.png' : '.jpg';
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + extension, {
            type: blob.type, lastModified: file.lastModified,
          }));
        }, mime, 0.95);
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(sourceUrl);
      }
    };
    image.src = sourceUrl;
  });
}
