/** Web replacement for expo-image-manipulator (canvas based, like its web module). */
export enum SaveFormat {
  JPEG = "jpeg",
  PNG = "png",
  WEBP = "webp",
}

type Action =
  | { resize: { width?: number; height?: number } }
  | { crop: { originX: number; originY: number; width: number; height: number } }
  | { rotate: number }
  | { flip: "vertical" | "horizontal" };

type SaveOptions = { compress?: number; format?: SaveFormat; base64?: boolean };

export type ImageResult = { uri: string; width: number; height: number; base64?: string };

function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Unable to load image for manipulation."));
    img.src = uri;
  });
}

function toCanvas(source: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function manipulateAsync(
  uri: string,
  actions: Action[] = [],
  saveOptions: SaveOptions = {},
): Promise<ImageResult> {
  const img = await loadImage(uri);
  let canvas = toCanvas(img, img.naturalWidth, img.naturalHeight);
  canvas.getContext("2d")!.drawImage(img, 0, 0);

  for (const action of actions) {
    if ("resize" in action) {
      const ratio = canvas.width / canvas.height;
      let { width, height } = action.resize;
      if (width && !height) height = Math.round(width / ratio);
      if (height && !width) width = Math.round(height * ratio);
      const next = toCanvas(canvas, width ?? canvas.width, height ?? canvas.height);
      next.getContext("2d")!.drawImage(canvas, 0, 0, next.width, next.height);
      canvas = next;
    } else if ("crop" in action) {
      const { originX, originY, width, height } = action.crop;
      const next = toCanvas(canvas, width, height);
      next.getContext("2d")!.drawImage(canvas, originX, originY, width, height, 0, 0, width, height);
      canvas = next;
    } else if ("rotate" in action) {
      const rad = (action.rotate * Math.PI) / 180;
      const sin = Math.abs(Math.sin(rad));
      const cos = Math.abs(Math.cos(rad));
      const w = Math.round(canvas.width * cos + canvas.height * sin);
      const h = Math.round(canvas.width * sin + canvas.height * cos);
      const next = toCanvas(canvas, w, h);
      const ctx = next.getContext("2d")!;
      ctx.translate(w / 2, h / 2);
      ctx.rotate(rad);
      ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
      canvas = next;
    } else if ("flip" in action) {
      const next = toCanvas(canvas, canvas.width, canvas.height);
      const ctx = next.getContext("2d")!;
      if (action.flip === "horizontal") {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      } else {
        ctx.translate(0, canvas.height);
        ctx.scale(1, -1);
      }
      ctx.drawImage(canvas, 0, 0);
      canvas = next;
    }
  }

  const format = saveOptions.format ?? SaveFormat.JPEG;
  const dataUrl = canvas.toDataURL(`image/${format}`, saveOptions.compress ?? 1);
  return {
    uri: dataUrl,
    width: canvas.width,
    height: canvas.height,
    ...(saveOptions.base64 ? { base64: dataUrl.split(",")[1] } : {}),
  };
}
