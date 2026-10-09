/** Web replacement for expo-document-picker, ported from its web module. */
export type DocumentPickerAsset = {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
  lastModified?: number;
  file?: File;
  base64?: string;
};

export type DocumentPickerResult =
  | { canceled: false; assets: DocumentPickerAsset[]; output?: FileList }
  | { canceled: true; assets: null };

export type DocumentPickerOptions = {
  type?: string | string[];
  multiple?: boolean;
  copyToCacheDirectory?: boolean;
  base64?: boolean;
};

export async function getDocumentAsync({
  type = "*/*",
  multiple = false,
  base64 = false,
}: DocumentPickerOptions = {}): Promise<DocumentPickerResult> {
  if (typeof document === "undefined") return { canceled: true, assets: null };
  const input = document.createElement("input");
  input.style.display = "none";
  input.setAttribute("type", "file");
  input.setAttribute("accept", Array.isArray(type) ? type.join(",") : type);
  input.setAttribute("id", String(Math.random()));
  if (multiple) input.setAttribute("multiple", "multiple");
  document.body.appendChild(input);

  return new Promise((resolve, reject) => {
    input.addEventListener("change", async () => {
      if (input.files) {
        try {
          const assets = await Promise.all(Array.from(input.files).map((f) => readFileAsync(f, base64)));
          resolve({ canceled: false, assets, output: input.files });
        } catch (e) {
          reject(e);
        }
      } else {
        resolve({ canceled: true, assets: null });
      }
      if (input.parentNode) document.body.removeChild(input);
    });
    input.addEventListener("cancel", () => {
      resolve({ canceled: true, assets: null });
      if (input.parentNode) document.body.removeChild(input);
    });
    input.dispatchEvent(new MouseEvent("click"));
  });
}

function readFileAsync(file: File, base64: boolean): Promise<DocumentPickerAsset> {
  return new Promise((resolve, reject) => {
    const base = {
      uri: URL.createObjectURL(file),
      mimeType: file.type,
      name: file.name,
      lastModified: file.lastModified,
      size: file.size,
      file,
    };
    if (!base64) {
      resolve(base);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read the selected media because the operation failed."));
    reader.onload = ({ target }) => resolve({ ...base, base64: String(target?.result ?? "") });
    reader.readAsDataURL(file);
  });
}
