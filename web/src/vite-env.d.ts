/// <reference types="vite/client" />

declare const __DEV__: boolean;

declare module "*.ttf" {
  const src: string;
  export default src;
}
