/** Web replacement for `@expo-google-fonts/geist` + expo-font's useFonts (same TTF files). */
import { useEffect, useState } from "react";
import geist500 from "../fonts/Geist_500Medium.ttf";
import geist700 from "../fonts/Geist_700Bold.ttf";
import geist800 from "../fonts/Geist_800ExtraBold.ttf";

export const Geist_500Medium = geist500;
export const Geist_700Bold = geist700;
export const Geist_800ExtraBold = geist800;

const loaded = new Set<string>();

async function loadFont(family: string, url: string) {
  if (loaded.has(family)) return;
  const face = new FontFace(family, `url(${url})`, { display: "auto" });
  await face.load();
  document.fonts.add(face);
  loaded.add(family);
}

export function useFonts(map: Record<string, string>): [boolean, Error | null] {
  const allLoaded = () => Object.keys(map).every((f) => loaded.has(f));
  const [state, setState] = useState<[boolean, Error | null]>([allLoaded(), null]);
  const key = Object.keys(map).join("|");
  useEffect(() => {
    let mounted = true;
    if (allLoaded()) return;
    Promise.all(Object.entries(map).map(([family, url]) => loadFont(family, url)))
      .then(() => mounted && setState([true, null]))
      .catch((error: Error) => mounted && setState([false, error]));
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
