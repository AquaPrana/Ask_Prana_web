/** Web replacement for expo-image-picker, ported from its web module (hidden <input type="file">). */
export type MediaType = "images" | "videos" | "livePhotos";

export type ImagePickerAsset = {
  uri: string;
  width: number;
  height: number;
  type?: "image" | "video";
  mimeType?: string;
  fileName?: string | null;
  fileSize?: number;
  file?: File;
  base64?: string | null;
  duration?: number | null;
  assetId?: string | null;
  exif?: Record<string, unknown> | null;
};

export type ImagePickerResult =
  | { canceled: false; assets: ImagePickerAsset[] }
  | { canceled: true; assets: null };

export type ImagePickerOptions = {
  mediaTypes?: MediaType | MediaType[] | string;
  allowsEditing?: boolean;
  allowsMultipleSelection?: boolean;
  selectionLimit?: number;
  aspect?: [number, number];
  quality?: number;
  base64?: boolean;
  exif?: boolean;
  cameraType?: CameraType;
};

export enum CameraType {
  back = "back",
  front = "front",
}

export enum PermissionStatus {
  GRANTED = "granted",
  UNDETERMINED = "undetermined",
  DENIED = "denied",
}

export type PermissionResponse = {
  status: PermissionStatus;
  expires: "never";
  granted: boolean;
  canAskAgain: boolean;
};

export const MediaTypeOptions = { All: "All", Images: "Images", Videos: "Videos" } as const;

const MediaTypeInput: Record<MediaType, string> = {
  images: "image/*",
  videos: "video/mp4,video/quicktime,video/x-m4v,video/*",
  livePhotos: "",
};

function parseMediaTypes(mediaTypes: ImagePickerOptions["mediaTypes"]): MediaType[] {
  if (!mediaTypes) return ["images"];
  if (Array.isArray(mediaTypes)) return mediaTypes as MediaType[];
  if (mediaTypes === "All") return ["images", "videos"];
  if (mediaTypes === "Videos") return ["videos"];
  if (mediaTypes === "Images") return ["images"];
  return [mediaTypes as MediaType];
}

function permissionGrantedResponse(): PermissionResponse {
  return { status: PermissionStatus.GRANTED, expires: "never", granted: true, canAskAgain: true };
}

export async function requestCameraPermissionsAsync() {
  return permissionGrantedResponse();
}
export async function getCameraPermissionsAsync() {
  return permissionGrantedResponse();
}
export async function requestMediaLibraryPermissionsAsync(_writeOnly?: boolean) {
  return permissionGrantedResponse();
}
export async function getMediaLibraryPermissionsAsync(_writeOnly?: boolean) {
  return permissionGrantedResponse();
}

export async function launchImageLibraryAsync(options: ImagePickerOptions = {}): Promise<ImagePickerResult> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { canceled: true, assets: null };
  }
  return openFileBrowserAsync({
    mediaTypes: parseMediaTypes(options.mediaTypes),
    allowsMultipleSelection: options.allowsMultipleSelection ?? false,
    base64: options.base64 ?? false,
  });
}

export async function launchCameraAsync(options: ImagePickerOptions = {}): Promise<ImagePickerResult> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { canceled: true, assets: null };
  }
  return openFileBrowserAsync({
    mediaTypes: parseMediaTypes(options.mediaTypes),
    allowsMultipleSelection: options.allowsMultipleSelection ?? false,
    capture: options.cameraType ?? true,
    base64: options.base64 ?? false,
  });
}

function openFileBrowserAsync({
  mediaTypes,
  capture = false,
  allowsMultipleSelection = false,
  base64,
}: {
  mediaTypes: MediaType[];
  capture?: boolean | CameraType;
  allowsMultipleSelection?: boolean;
  base64: boolean;
}): Promise<ImagePickerResult> {
  const input = document.createElement("input");
  input.style.display = "none";
  input.setAttribute("type", "file");
  input.setAttribute("accept", createMediaTypeFormat(mediaTypes));
  input.setAttribute("id", String(Math.random()));
  input.setAttribute("data-testid", "file-input");
  if (allowsMultipleSelection) input.setAttribute("multiple", "multiple");
  if (capture) {
    if (capture === true) input.setAttribute("capture", "camera");
    else if (capture === CameraType.front) input.setAttribute("capture", "user");
    else input.setAttribute("capture", "environment");
  }
  document.body.appendChild(input);

  return new Promise((resolve, reject) => {
    input.addEventListener("change", async () => {
      if (input.files?.length) {
        const files = allowsMultipleSelection ? Array.from(input.files) : [input.files[0]];
        try {
          const assets = await Promise.all(files.filter(Boolean).map((file) => readFile(file, { base64 })));
          resolve({ canceled: false, assets });
        } catch (error) {
          reject(error);
        }
      } else {
        resolve({ canceled: true, assets: null });
      }
      if (input.parentNode) document.body.removeChild(input);
    });
    input.addEventListener("cancel", () => {
      input.dispatchEvent(new Event("change"));
    });
    input.dispatchEvent(new MouseEvent("click"));
  });
}

function getImageMetadata(blobUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth ?? image.width, height: image.naturalHeight ?? image.height });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = blobUrl;
  });
}

function getVideoMetadata(blobUrl: string): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
    video.onerror = () => resolve({ width: 0, height: 0, duration: 0 });
    video.src = blobUrl;
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read the selected media because the operation failed."));
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to read file as base64"));
        return;
      }
      resolve(result.split(",")?.[1] ?? "");
    };
    reader.readAsDataURL(file);
  });
}

async function readFile(file: File, options: { base64: boolean }): Promise<ImagePickerAsset> {
  const mimeType = file.type;
  const uri = URL.createObjectURL(file);
  let metadata: { width: number; height: number; duration?: number };
  if (mimeType.startsWith("image/")) metadata = await getImageMetadata(uri);
  else if (mimeType.startsWith("video/")) metadata = await getVideoMetadata(uri);
  else throw new Error(`Unsupported file type: ${mimeType}. Only images and videos are supported.`);
  const base64 = options.base64 ? await readFileAsBase64(file) : undefined;
  return {
    uri,
    width: metadata.width,
    height: metadata.height,
    type: mimeType.startsWith("image/") ? "image" : "video",
    mimeType,
    fileName: file.name,
    fileSize: file.size,
    file,
    ...(metadata.duration !== undefined ? { duration: metadata.duration } : {}),
    ...(base64 ? { base64 } : {}),
  };
}

function createMediaTypeFormat(mediaTypes: MediaType[]): string {
  const filtered = mediaTypes.filter((t) => t !== "livePhotos");
  if (filtered.length === 0) return "image/*";
  let result = "";
  for (const t of filtered) {
    if (!result.includes(MediaTypeInput[t])) result = result.concat(",", MediaTypeInput[t]);
  }
  return result;
}
