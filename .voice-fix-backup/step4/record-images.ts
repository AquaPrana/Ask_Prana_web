import * as ImagePicker from "expo-image-picker";
import { Alert, Platform } from "react-native";
import {
  MAX_CYCLE_IMPORT_BYTES,
  isUnsupportedRecordType,
  sniffRecordMimeFromBytes,
} from "./cycle-import-files";
import { getSupabasePublicConfig, supabase } from "./supabase";

const CAMERA_PERMISSION_ALERT =
  "Camera permission is required to capture photos.";
const LIBRARY_PERMISSION_ALERT =
  "Photo library permission is required to select images.";

export type PickedImage = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
};

export type UploadedImageResult = {
  localUri: string;
  fileName: string;
  remoteUrl: string | null;
  error: string | null;
  path?: string | null;
};

export const requestCameraPermission = async () => {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();

  if (status !== "granted") {
    Alert.alert("Permission needed", CAMERA_PERMISSION_ALERT);
    return false;
  }

  return true;
};

export const requestMediaLibraryPermission = async () => {
  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (status !== "granted") {
    Alert.alert("Permission needed", LIBRARY_PERMISSION_ALERT);
    return false;
  }

  return true;
};

export const pickImageFromCamera = async (): Promise<string[] | null> => {
  const hasPermission = await requestCameraPermission();
  if (!hasPermission) {
    return null;
  }

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    quality: 0.8,
  });

  if (result.canceled || !result.assets.length) {
    return null;
  }

  return result.assets.map((asset) => asset.uri);
};

export const pickImagesFromGallery = async (
  selectionLimit = 0,
): Promise<string[] | null> => {
  const hasPermission = await requestMediaLibraryPermission();
  if (!hasPermission) {
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: selectionLimit !== 1,
    selectionLimit: selectionLimit > 0 ? selectionLimit : 0,
    quality: 0.8,
  });

  if (result.canceled || !result.assets.length) {
    return null;
  }

  return result.assets.map((asset) => asset.uri);
};

export const pickRecordImages = async (
  remainingSlots = 5,
): Promise<string[] | null> => {
  if (remainingSlots <= 0) {
    return null;
  }

  if (Platform.OS === "web") {
    return pickImagesFromGallery(remainingSlots);
  }

  return new Promise((resolve) => {
    Alert.alert("Add photo", "Choose how you want to add the image.", [
      {
        text: "Camera",
        onPress: () => {
          void pickImageFromCamera()
            .then(resolve)
            .catch(() => resolve(null));
        },
      },
      {
        text: "Gallery",
        onPress: () => {
          void pickImagesFromGallery(remainingSlots)
            .then(resolve)
            .catch(() => resolve(null));
        },
      },
      { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
    ]);
  });
};

export const pickMultipleImages = async (
  selectionLimit = 5,
): Promise<PickedImage[] | null> => {
  const hasPermission = await requestMediaLibraryPermission();
  if (!hasPermission) {
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: selectionLimit > 0 ? selectionLimit : 0,
    quality: 0.8,
  });

  if (result.canceled || !result.assets.length) {
    return null;
  }

  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    fileName: asset.fileName ?? `image-${Date.now()}-${index}.jpg`,
    mimeType: asset.mimeType ?? "image/jpeg",
  }));
};

export const pickSingleImage = async (
  source: "camera" | "gallery",
): Promise<PickedImage | null> => {
  if (source === "camera") {
    const hasPermission = await requestCameraPermission();
    if (!hasPermission) {
      return null;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });

    if (result.canceled || !result.assets.length) {
      return null;
    }

    const asset = result.assets[0];
    return {
      uri: asset.uri,
      fileName: asset.fileName ?? `photo-${Date.now()}.jpg`,
      mimeType: asset.mimeType ?? "image/jpeg",
    };
  }

  const hasPermission = await requestMediaLibraryPermission();
  if (!hasPermission) {
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: false,
    quality: 0.8,
  });

  if (result.canceled || !result.assets.length) {
    return null;
  }

  const asset = result.assets[0];
  return {
    uri: asset.uri,
    fileName: asset.fileName ?? `image-${Date.now()}.jpg`,
    mimeType: asset.mimeType ?? "image/jpeg",
  };
};

export const promptImageSource = (
  onPick: (source: "camera" | "gallery") => void,
) => {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.confirm("Open file picker for photo?")) {
      onPick("gallery");
    }
    return;
  }

  Alert.alert("Add photo", "Choose how you want to add the image.", [
    { text: "Camera", onPress: () => onPick("camera") },
    { text: "Gallery", onPress: () => onPick("gallery") },
    { text: "Cancel", style: "cancel" },
  ]);
};

export const pickRecordImage = async (): Promise<PickedImage | null> => {
  if (Platform.OS === "web") {
    return pickSingleImage("gallery");
  }

  return new Promise((resolve) => {
    Alert.alert("Add photo", "Choose how you want to add the image.", [
      {
        text: "Camera",
        onPress: () => {
          void pickSingleImage("camera")
            .then(resolve)
            .catch(() => resolve(null));
        },
      },
      {
        text: "Gallery",
        onPress: () => {
          void pickSingleImage("gallery")
            .then(resolve)
            .catch(() => resolve(null));
        },
      },
      { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
    ]);
  });
};

export {
  MAX_CYCLE_IMPORT_BYTES,
  MAX_CYCLE_IMPORT_FILES,
  isSupportedRecordType,
  isUnsupportedRecordType,
  sniffRecordMimeFromBytes,
} from "./cycle-import-files";

function extensionFromName(value?: string | null) {
  const name = (value ?? "").split("?")[0].toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1);
}

const guessExtension = (
  uri: string,
  mimeType?: string | null,
  fileName?: string | null,
) => {
  const named = extensionFromName(fileName);
  if (named && named.length <= 5) {
    return named;
  }
  if (mimeType?.includes("png")) return "png";
  if (mimeType?.includes("webp")) return "webp";
  if (mimeType?.includes("pdf")) return "pdf";
  if (mimeType?.includes("jpeg") || mimeType?.includes("jpg")) return "jpg";
  const fromUri = extensionFromName(uri);
  if (fromUri && fromUri.length <= 5) {
    return fromUri;
  }
  return "jpg";
};

function uriSchemeOf(uri: string) {
  const colon = uri.indexOf(":");
  return colon > 0 ? uri.slice(0, colon) : "";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const start = bytes.byteOffset;
  const end = start + bytes.byteLength;
  const sliced = bytes.buffer.slice(start, end);
  if (sliced instanceof ArrayBuffer) {
    return sliced;
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function readLocalFileBytesWeb(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  // React Native local file:// fetches can report status 0 with a valid body.
  if (!response.ok && response.status !== 0) {
    throw new Error(`Unable to read image (${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 1) {
    throw new Error("EMPTY_FILE");
  }
  return bytes;
}

async function readLocalFileBytesNative(uri: string): Promise<Uint8Array> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onload = () => {
      if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) {
        reject(new Error(`Unable to read image (${xhr.status}).`));
        return;
      }
      if (!(xhr.response instanceof ArrayBuffer) || xhr.response.byteLength < 1) {
        reject(new Error("EMPTY_FILE"));
        return;
      }
      resolve(xhr.response);
    };
    xhr.onerror = () => reject(new Error("Unable to read image."));
    xhr.onabort = () => reject(new Error("Unable to read image."));
    xhr.responseType = "arraybuffer";
    xhr.open("GET", uri);
    xhr.send();
  });
  return new Uint8Array(buffer);
}

async function readLocalFileBytes(uri: string): Promise<Uint8Array> {
  if (Platform.OS === "web") {
    return readLocalFileBytesWeb(uri);
  }
  try {
    return await readLocalFileBytesNative(uri);
  } catch {
    return readLocalFileBytesWeb(uri);
  }
}

function inferCycleImportMime(
  uri: string,
  fileName?: string | null,
  mimeType?: string | null,
) {
  const incoming = (mimeType ?? "").toLowerCase().split(";")[0]?.trim() || "";
  if (
    incoming === "image/jpeg" ||
    incoming === "image/jpg" ||
    incoming === "image/png" ||
    incoming === "image/webp" ||
    incoming === "application/pdf"
  ) {
    return incoming === "image/jpg" ? "image/jpeg" : incoming;
  }
  const ext = guessExtension(uri, mimeType, fileName);
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  return "image/jpeg";
}

export const uploadImageToSupabaseStorage = async ({
  uri,
  fileName,
  mimeType,
  folder = "records",
  bucket = "pond-records",
  objectPath,
  upsert = false,
}: {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  folder?: string;
  bucket?: string;
  /** Absolute path inside the bucket. Must start with the signed-in user id. */
  objectPath?: string;
  upsert?: boolean;
}): Promise<UploadedImageResult> => {
  const inferredMime = inferCycleImportMime(uri, fileName, mimeType);
  const fallbackName =
    Platform.OS === "web"
      ? `image-${Date.now()}.${guessExtension(uri, inferredMime, fileName)}`
      : `join-cycle-image.${guessExtension(uri, inferredMime, fileName)}`;
  const safeName =
    fileName?.replace(/[^a-zA-Z0-9._-]/g, "_") || fallbackName;

  try {
    const config = getSupabasePublicConfig();
    if (!config.url || !config.hasAnonKey || !config.isValidUrl) {
      return {
        localUri: uri,
        fileName: safeName,
        remoteUrl: null,
        error:
          "Supabase is not configured correctly. Check EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.",
        path: null,
      };
    }

    if (
      config.hostname === "localhost" ||
      config.hostname === "127.0.0.1" ||
      config.hostname === "0.0.0.0"
    ) {
      return {
        localUri: uri,
        fileName: safeName,
        remoteUrl: null,
        error:
          "Supabase URL points to localhost. Use your remote project URL (*.supabase.co).",
        path: null,
      };
    }

    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    const user = session?.user;
    if (sessionError || !user?.id) {
      return {
        localUri: uri,
        fileName: safeName,
        remoteUrl: null,
        error: "User session is unavailable. Please sign in again.",
        path: null,
      };
    }

    if (isUnsupportedRecordType(mimeType ?? inferredMime, safeName)) {
      return {
        localUri: uri,
        fileName: safeName,
        remoteUrl: null,
        error:
          "HEIC images are not currently supported. Please upload JPG, PNG, WEBP or PDF.",
        path: null,
      };
    }

    const ownerPrefix = user.id.trim();
    const customPath = objectPath?.replace(/^\/+/, "").trim() || "";
    if (customPath && !customPath.startsWith(`${ownerPrefix}/`)) {
      return {
        localUri: uri,
        fileName: safeName,
        remoteUrl: null,
        error: "Invalid storage path for this account.",
        path: null,
      };
    }
    const path =
      customPath || `${ownerPrefix}/${folder}/${Date.now()}-${safeName}`;

    const { error: bucketError } = await supabase.storage
      .from(bucket)
      .list("", { limit: 1 });

    if (bucketError) {
      const bucketMessage = bucketError.message?.toLowerCase() ?? "";
      if (
        bucketMessage.includes("bucket") ||
        bucketMessage.includes("not found") ||
        bucketMessage.includes("does not exist")
      ) {
        return {
          localUri: uri,
          fileName: safeName,
          remoteUrl: null,
          error: `Storage bucket "${bucket}" is missing or inaccessible.`,
          path: null,
        };
      }
      console.log("[CycleImport] bucket list warning:", bucketError.message);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readLocalFileBytes(uri);
    } catch (readError) {
      const message =
        readError instanceof Error ? readError.message : "Unable to read image.";
      console.log("[CycleImport] file read failed", {
        platform: Platform.OS,
        uriScheme: uriSchemeOf(uri),
        fileName: safeName,
        mimeType: inferredMime,
        message,
      });
      return {
        localUri: uri,
        fileName: safeName,
        remoteUrl: null,
        error:
          message === "EMPTY_FILE" || message.toLowerCase().includes("failed to fetch")
            ? "This image could be previewed but AquaPrana could not read its file data. Please select it again."
            : message,
        path: null,
      };
    }

    if (bytes.byteLength > MAX_CYCLE_IMPORT_BYTES) {
      return {
        localUri: uri,
        fileName: safeName,
        remoteUrl: null,
        error: "This file is larger than the 10 MB limit.",
        path: null,
      };
    }

    const sniffed = sniffRecordMimeFromBytes(bytes, inferredMime);
    if (isUnsupportedRecordType(sniffed, safeName)) {
      return {
        localUri: uri,
        fileName: safeName,
        remoteUrl: null,
        error:
          "HEIC images are not currently supported. Please upload JPG, PNG, WEBP or PDF.",
        path: null,
      };
    }

    const contentType = ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
      sniffed,
    )
      ? sniffed
      : inferredMime;

    const uploadBody =
      Platform.OS === "web"
        ? new Blob([bytes.buffer as ArrayBuffer], { type: contentType })
        : toArrayBuffer(bytes);
    const uploadBodyType =
      Platform.OS === "web" ? "Blob" : "ArrayBuffer";

    console.log("[CycleImport] upload started", {
      platform: Platform.OS,
      uriScheme: uriSchemeOf(uri),
      fileName: safeName,
      mimeType: contentType,
      fileSize: bytes.byteLength,
      bytesRead: bytes.byteLength,
      uploadBodyType,
      bucket,
      storagePath: path,
    });

    const { error } = await supabase.storage.from(bucket).upload(path, uploadBody, {
      contentType,
      upsert,
    });

    if (error) {
      console.log("[CycleImport] FAILED", {
        stage: "storage_upload",
        platform: Platform.OS,
        uploadBodyType,
        bucket,
        storagePath: path,
        message: error.message,
      });
      return {
        localUri: uri,
        fileName: safeName,
        remoteUrl: null,
        error: error.message,
        path: null,
      };
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    console.log("[CycleImport] storage upload success", {
      platform: Platform.OS,
      uploadBodyType,
      bucket,
      storagePath: path,
    });

    return {
      localUri: uri,
      fileName: safeName,
      remoteUrl: data.publicUrl ?? null,
      error: null,
      path,
    };
  } catch (error) {
    const raw =
      error instanceof Error ? error.message : "Unable to upload image right now.";
    const friendly = raw.toLowerCase().includes("failed to fetch")
      ? "Network error while uploading. Check your connection and try again."
      : raw.toLowerCase().includes("arraybufferview") ||
          raw.toLowerCase().includes("creating blobs")
        ? "This file could not be prepared for Android upload. Please select it again."
        : raw;

    console.log("[CycleImport] uploadImageToSupabaseStorage failed:", {
      platform: Platform.OS,
      uriScheme: uriSchemeOf(uri),
      fileName: safeName,
      error: raw,
    });

    return {
      localUri: uri,
      fileName: safeName,
      remoteUrl: null,
      error: friendly,
      path: null,
    };
  }
};

export const isNativeImagePickerAvailable = Platform.OS !== "web";
