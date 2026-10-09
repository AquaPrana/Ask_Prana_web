import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Alert, Image as RNImage, Linking, Platform } from "react-native";
import { uploadImageToSupabaseStorage } from "./record-images";
import { supabase } from "./supabase";
import { isAppSessionToken, loadAppSession } from "../services/app-session";
import { updateAppSessionAvatar, updateCurrentUserAvatar } from "../services/profile";

export const PROFILE_PHOTOS_BUCKET = "profile-photos";
const PROFILE_PHOTO_MAX_EDGE = 1024;
const PROFILE_PHOTO_JPEG_QUALITY = 0.82;
/** Client-side size cap before upload (matches storage bucket limit). */
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export type ProfilePhotoPickResult = {
  localUri: string;
  remoteUrl: string;
  updatedAt: string;
  storagePath: string;
};

export type ProfilePhotoAction = "camera" | "gallery" | "remove" | "cancel";

/** Cache-bust display URL so avatars refresh after replace at the same path. */
export function avatarDisplayUrl(
  avatarUrl?: string | null,
  updatedAt?: string | null,
): string | null {
  const base = avatarUrl?.trim();
  if (!base) {
    return null;
  }
  const stamp =
    updatedAt && !Number.isNaN(Date.parse(updatedAt))
      ? Date.parse(updatedAt)
      : Date.now();
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}v=${stamp}`;
}

function promptProfilePhotoActionWeb(hasExistingPhoto: boolean): Promise<ProfilePhotoAction> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.setAttribute("role", "dialog");
    root.style.cssText =
      "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);padding:24px;";
    const panel = document.createElement("div");
    panel.style.cssText =
      "width:100%;max-width:320px;display:flex;flex-direction:column;gap:8px;padding:16px;border-radius:10px;background:#212121;border:1px solid #363636;";
    const title = document.createElement("div");
    title.textContent = "Profile photo";
    title.style.cssText = "color:#F5F5F5;font:600 16px sans-serif;margin-bottom:4px;";
    panel.appendChild(title);
    const finish = (action: ProfilePhotoAction) => {
      root.remove();
      resolve(action);
    };
    const addButton = (label: string, action: ProfilePhotoAction, color: string) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.cssText = `min-height:40px;border-radius:8px;border:1px solid #363636;background:#171717;color:${color};font:600 14px sans-serif;cursor:pointer;`;
      button.addEventListener("click", () => finish(action));
      panel.appendChild(button);
    };
    addButton("Choose from Gallery", "gallery", "#F5F5F5");
    if (hasExistingPhoto) addButton("Remove Photo", "remove", "#F87171");
    addButton("Cancel", "cancel", "#A0A0A0");
    root.addEventListener("click", (event) => {
      if (event.target === root) finish("cancel");
    });
    root.appendChild(panel);
    document.body.appendChild(root);
  });
}

export function promptProfilePhotoAction(
  hasExistingPhoto: boolean,
): Promise<ProfilePhotoAction> {
  if (Platform.OS === "web") {
    if (typeof document === "undefined") return Promise.resolve("cancel");
    return promptProfilePhotoActionWeb(hasExistingPhoto);
  }

  return new Promise((resolve) => {
    const buttons: {
      text: string;
      style?: "cancel" | "destructive" | "default";
      onPress?: () => void;
    }[] = [
      { text: "Take Photo", onPress: () => resolve("camera") },
      { text: "Choose from Gallery", onPress: () => resolve("gallery") },
    ];
    if (hasExistingPhoto) {
      buttons.push({
        text: "Remove Photo",
        style: "destructive",
        onPress: () => resolve("remove"),
      });
    }
    buttons.push({
      text: "Cancel",
      style: "cancel",
      onPress: () => resolve("cancel"),
    });
    Alert.alert("Profile photo", "Choose an option", buttons);
  });
}

function explainPermissionDenied(kind: "camera" | "library") {
  const title = "Permission needed";
  const message =
    kind === "camera"
      ? "Camera access is required to take a profile photo. You can enable it in Settings."
      : "Photo library access is required to choose a profile photo. You can enable it in Settings.";

  Alert.alert(title, message, [
    { text: "Not now", style: "cancel" },
    {
      text: "Open Settings",
      onPress: () => {
        void Linking.openSettings().catch(() => undefined);
      },
    },
  ]);
}

async function ensureProfilePhotoPermission(
  kind: "camera" | "library",
): Promise<boolean> {
  // Browsers handle file/camera prompts themselves.
  if (Platform.OS === "web") {
    return true;
  }

  const response =
    kind === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

  if (response.status === "granted") {
    return true;
  }

  explainPermissionDenied(kind);
  return false;
}

async function pickRawProfileUri(
  source: "camera" | "gallery",
): Promise<string | null> {
  if (source === "camera") {
    const granted = await ensureProfilePhotoPermission("camera");
    if (!granted) {
      return null;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
      exif: false,
    });

    if (result.canceled || !result.assets.length) {
      return null;
    }
    return result.assets[0].uri;
  }

  const granted = await ensureProfilePhotoPermission("library");
  if (!granted) {
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: Platform.OS !== "web",
    aspect: [1, 1],
    quality: 0.9,
    allowsMultipleSelection: false,
    exif: false,
  });

  if (result.canceled || !result.assets.length) {
    return null;
  }
  return result.assets[0].uri;
}

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    RNImage.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      (error) => reject(error),
    );
  });
}

/**
 * Center-crop to square, resize, and re-encode as JPEG (strips EXIF / orientation issues).
 */
export async function prepareProfilePhoto(uri: string): Promise<{
  uri: string;
  error: string | null;
}> {
  try {
    const { width, height } = await getImageSize(uri);
    if (!width || !height) {
      return { uri, error: "Unable to read the selected image." };
    }

    const edge = Math.min(width, height);
    const originX = Math.max(0, Math.floor((width - edge) / 2));
    const originY = Math.max(0, Math.floor((height - edge) / 2));
    const resizeEdge = Math.min(PROFILE_PHOTO_MAX_EDGE, edge);

    const result = await ImageManipulator.manipulateAsync(
      uri,
      [
        {
          crop: {
            originX,
            originY,
            width: edge,
            height: edge,
          },
        },
        { resize: { width: resizeEdge } },
      ],
      {
        compress: PROFILE_PHOTO_JPEG_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
      },
    );

    if (!result.uri) {
      return { uri, error: "Unable to prepare the selected image." };
    }
    return { uri: result.uri, error: null };
  } catch (error) {
    console.log("[profile-photo] prepare failed:", error);
    try {
      const fallback = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: PROFILE_PHOTO_MAX_EDGE } }],
        {
          compress: PROFILE_PHOTO_JPEG_QUALITY,
          format: ImageManipulator.SaveFormat.JPEG,
        },
      );
      return { uri: fallback.uri || uri, error: null };
    } catch (fallbackError) {
      console.log("[profile-photo] fallback compress failed:", fallbackError);
      return {
        uri,
        error: "Unable to process this image. Please try another photo.",
      };
    }
  }
}

/**
 * Pick a photo (camera/gallery with square crop UI where supported).
 * Does not upload — caller shows preview, then calls uploadPreparedProfilePhoto.
 */
export async function pickProfilePhotoCandidate(
  source: "camera" | "gallery",
): Promise<{ localUri: string | null; error: string | null; canceled: boolean }> {
  try {
    const rawUri = await pickRawProfileUri(source);
    if (!rawUri) {
      return { localUri: null, error: null, canceled: true };
    }

    const prepared = await prepareProfilePhoto(rawUri);
    if (prepared.error) {
      return { localUri: null, error: prepared.error, canceled: false };
    }

    return { localUri: prepared.uri, error: null, canceled: false };
  } catch (error) {
    return {
      localUri: null,
      error:
        error instanceof Error
          ? error.message
          : "Unable to select a profile photo.",
      canceled: false,
    };
  }
}

export function storagePathFromAvatarUrl(
  avatarUrl?: string | null,
): string | null {
  const url = avatarUrl?.trim();
  if (!url) {
    return null;
  }

  const marker = `/object/public/${PROFILE_PHOTOS_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx >= 0) {
    const path = decodeURIComponent(
      url.slice(idx + marker.length).split("?")[0] ?? "",
    );
    return path || null;
  }

  const alt = `/storage/v1/object/public/${PROFILE_PHOTOS_BUCKET}/`;
  const altIdx = url.indexOf(alt);
  if (altIdx >= 0) {
    const path = decodeURIComponent(
      url.slice(altIdx + alt.length).split("?")[0] ?? "",
    );
    return path || null;
  }

  return null;
}

async function deleteStorageObject(
  path: string | null | undefined,
  expectedUserId?: string | null,
): Promise<{ error: string | null }> {
  const clean = path?.trim();
  if (!clean) {
    return { error: null };
  }

  const owner = expectedUserId?.trim();
  if (owner && !clean.startsWith(`${owner}/`)) {
    console.log(
      "[profile-photo] refused storage cleanup for non-owned path:",
      clean,
    );
    return { error: "Storage cleanup skipped: path is not owned by this user." };
  }

  const { error } = await supabase.storage
    .from(PROFILE_PHOTOS_BUCKET)
    .remove([clean]);
  if (error) {
    console.log("[profile-photo] storage cleanup warning:", error.message);
    return { error: error.message };
  }
  return { error: null };
}

/**
 * Upload a prepared local JPEG and persist avatar_url for the signed-in user.
 * Keeps the previous avatar_url until both upload + DB update succeed.
 * Deletes the new object if the DB update fails.
 */
async function readImageBase64(uri: string): Promise<{ base64: string | null; error: string | null }> {
  try {
    const response = await fetch(uri);
    const blob = await response.blob();
    if (blob.size > PROFILE_PHOTO_MAX_BYTES) {
      return {
        base64: null,
        error: "This photo is larger than the 5 MB limit. Please choose a smaller image.",
      };
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const comma = dataUrl.indexOf(",");
    return { base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, error: null };
  } catch {
    return { base64: null, error: "Unable to read the selected image." };
  }
}

export async function uploadPreparedProfilePhoto(
  localUri: string,
  previousAvatarUrl?: string | null,
): Promise<{
  data: ProfilePhotoPickResult | null;
  error: string | null;
}> {
  const appSession = await loadAppSession();
  if (isAppSessionToken(appSession?.access_token)) {
    const image = await readImageBase64(localUri);
    if (image.error || !image.base64) {
      return { data: null, error: image.error ?? "Unable to read the selected image." };
    }
    const saved = await updateAppSessionAvatar({ imageBase64: image.base64 });
    if (saved.error || !saved.avatarUrl || !saved.avatarUpdatedAt) {
      return { data: null, error: saved.error?.message ?? "Unable to upload profile photo." };
    }
    return {
      data: {
        localUri,
        remoteUrl: saved.avatarUrl,
        updatedAt: saved.avatarUpdatedAt,
        storagePath: storagePathFromAvatarUrl(saved.avatarUrl) ?? "",
      },
      error: null,
    };
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user?.id?.trim();
  if (!userId) {
    return {
      data: null,
      error: "You must be signed in to update your photo.",
    };
  }

  const objectPath = `${userId}/profile-${Date.now()}.jpg`;

  try {
    const probe = await fetch(localUri);
    const blob = await probe.blob();
    if (blob.size > PROFILE_PHOTO_MAX_BYTES) {
      return {
        data: null,
        error: "This photo is larger than the 5 MB limit. Please choose a smaller image.",
      };
    }
    if (blob.type && !blob.type.startsWith("image/")) {
      return {
        data: null,
        error: "Only image files are supported for profile photos.",
      };
    }
  } catch {
    // Some native file URIs cannot be probed via fetch; upload helper still validates.
  }

  const uploaded = await uploadImageToSupabaseStorage({
    uri: localUri,
    fileName: "profile.jpg",
    mimeType: "image/jpeg",
    folder: "avatar",
    bucket: PROFILE_PHOTOS_BUCKET,
    objectPath,
    upsert: false,
  });

  if (uploaded.error || !uploaded.remoteUrl || !uploaded.path) {
    return {
      data: null,
      error: uploaded.error ?? "Unable to upload profile photo.",
    };
  }

  // Extra client size guard (upload helper also enforces a larger generic cap).
  // Re-read is expensive; rely on storage bucket limit + JPEG compress for size.

  const updatedAt = new Date().toISOString();
  const { error: dbError } = await updateCurrentUserAvatar({
    avatarUrl: uploaded.remoteUrl,
    avatarUpdatedAt: updatedAt,
  });

  if (dbError) {
    await deleteStorageObject(uploaded.path, userId);
    return {
      data: null,
      error: dbError.message,
    };
  }

  const previousPath = storagePathFromAvatarUrl(previousAvatarUrl);
  if (previousPath && previousPath !== uploaded.path) {
    await deleteStorageObject(previousPath, userId);
  }

  return {
    data: {
      localUri,
      remoteUrl: uploaded.remoteUrl,
      updatedAt,
      storagePath: uploaded.path,
    },
    error: null,
  };
}

/**
 * Clear avatar_url first, then delete the storage object for this user only.
 * If the photo is already cleared, treat as success.
 * Storage cleanup failures after a successful DB clear are returned as warnings only.
 */
export async function removeProfilePhoto(
  previousAvatarUrl?: string | null,
): Promise<{
  error: string | null;
  updatedAt: string | null;
  cleanupWarning: string | null;
  alreadyRemoved: boolean;
}> {
  const appSession = await loadAppSession();
  if (isAppSessionToken(appSession?.access_token)) {
    if (!previousAvatarUrl?.trim()) {
      return {
        error: null,
        updatedAt: new Date().toISOString(),
        cleanupWarning: null,
        alreadyRemoved: true,
      };
    }
    const saved = await updateAppSessionAvatar({ remove: true });
    if (saved.error) {
      return {
        error: saved.error.message,
        updatedAt: null,
        cleanupWarning: null,
        alreadyRemoved: false,
      };
    }
    return {
      error: null,
      updatedAt: saved.avatarUpdatedAt,
      cleanupWarning: null,
      alreadyRemoved: false,
    };
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user?.id?.trim();
  if (!userId) {
    return {
      error: "You must be signed in to remove your photo.",
      updatedAt: null,
      cleanupWarning: null,
      alreadyRemoved: false,
    };
  }

  const previousPath = storagePathFromAvatarUrl(previousAvatarUrl);
  const hasStoredReference = Boolean(previousAvatarUrl?.trim());

  if (!hasStoredReference) {
    return {
      error: null,
      updatedAt: new Date().toISOString(),
      cleanupWarning: null,
      alreadyRemoved: true,
    };
  }

  const updatedAt = new Date().toISOString();
  const { error } = await updateCurrentUserAvatar({
    avatarUrl: null,
    avatarUpdatedAt: updatedAt,
  });

  if (error) {
    return {
      error: error.message,
      updatedAt: null,
      cleanupWarning: null,
      alreadyRemoved: false,
    };
  }

  const cleanup = await deleteStorageObject(previousPath, userId);
  return {
    error: null,
    updatedAt,
    cleanupWarning: cleanup.error,
    alreadyRemoved: false,
  };
}

/** @deprecated Prefer pick → preview → uploadPreparedProfilePhoto */
export async function pickAndUploadProfilePhoto(): Promise<{
  data: ProfilePhotoPickResult | null;
  error: string | null;
  canceled: boolean;
}> {
  const action = await promptProfilePhotoAction(false);
  if (action === "cancel" || action === "remove") {
    return { data: null, error: null, canceled: true };
  }

  const picked = await pickProfilePhotoCandidate(action);
  if (picked.canceled || !picked.localUri) {
    return {
      data: null,
      error: picked.error,
      canceled: picked.canceled,
    };
  }

  const uploaded = await uploadPreparedProfilePhoto(picked.localUri);
  return {
    data: uploaded.data,
    error: uploaded.error,
    canceled: false,
  };
}

/** @deprecated Prefer removeProfilePhoto */
export async function clearProfilePhoto(): Promise<{ error: string | null }> {
  const result = await removeProfilePhoto(null);
  return { error: result.error };
}
